import {
  S3Client,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  GetBucketEncryptionCommand,
} from '@aws-sdk/client-s3';
import { KMSClient, GetKeyPolicyCommand, PutKeyPolicyCommand } from '@aws-sdk/client-kms';
import { AWS_ATHENA_ROLE_ARN } from '../../../constant';
import { IS3Config } from '../../../models';

// SID stamped on our statement so we can detect and skip re-adding it.
const ATHENA_POLICY_SID = 'DataCraftAthenaRoleAccess';

// S3 bucket policy writes are strongly consistent (AWS guarantee since 2020),
// but two concurrent callers can still race: both read the same policy before
// either writes. We retry the full fetch→check→merge→put cycle on transient
// failures, which covers both network blips and lost-update races.
const POLICY_UPDATE_MAX_RETRIES = 3;

type BucketPolicy = { Version: string; Statement: any[] };

const buildEmptyBucketPolicy = (): BucketPolicy => ({
  Version: '2012-10-17',
  Statement: [],
});

// Athena both READS the client's backup data and WRITES its query results into
// the same bucket, under {backupConfigId}/retrieve/ (see athena/query.ts), so
// the grant covers the write side too. The full write set is what Athena
// requires for a result location — result files are written as multipart
// uploads, which need the abort/list-parts actions to clean up a failed query.
//   s3:GetObject / s3:ListBucket   — query execution + partition discovery
//   s3:GetBucketLocation           — resolve the result bucket's region
//   s3:PutObject                   — write the result file
//   s3:ListBucketMultipartUploads / s3:ListMultipartUploadParts /
//   s3:AbortMultipartUpload        — multipart result writes and their cleanup
const REQUIRED_ATHENA_ACTIONS = [
  's3:GetObject',
  's3:ListBucket',
  's3:GetBucketLocation',
  's3:PutObject',
  's3:ListBucketMultipartUploads',
  's3:ListMultipartUploadParts',
  's3:AbortMultipartUpload',
];

const ATHENA_KMS_POLICY_SID = 'DataCraftKmsAccessPolicy';
const REQUIRED_ATHENA_KMS_ACTIONS = ['kms:Decrypt', 'kms:DescribeKey'];

type KeyPolicy = { Version: string; Statement: any[] };

const buildAthenaKmsStatement = () => ({
  Sid: ATHENA_KMS_POLICY_SID,
  Effect: 'Allow',
  Principal: { AWS: AWS_ATHENA_ROLE_ARN },
  Action: REQUIRED_ATHENA_KMS_ACTIONS,
  Resource: ['*'],
});

const resolveBucketKmsKeyId = async (s3: S3Client, bucketName: string): Promise<string | null> => {
  try {
    const { ServerSideEncryptionConfiguration } = await s3.send(
      new GetBucketEncryptionCommand({ Bucket: bucketName })
    );
    const rule = ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
    if (!rule || (rule.SSEAlgorithm !== 'aws:kms' && rule.SSEAlgorithm !== 'aws:kms:dsse')) {
      return null;
    }
    return rule.KMSMasterKeyID ?? null;
  } catch (err: any) {
    if (err.name === 'ServerSideEncryptionConfigurationNotFoundError') {
      return null;
    }
    throw err;
  }
};

const fetchCurrentKeyPolicy = async (kms: KMSClient, keyId: string): Promise<KeyPolicy> => {
  const { Policy } = await kms.send(new GetKeyPolicyCommand({ KeyId: keyId, PolicyName: 'default' }));
  return JSON.parse(Policy!) as KeyPolicy;
};

const findAthenaKmsStatement = (policy: KeyPolicy): any | undefined =>
  policy.Statement.find((statement) => statement.Sid === ATHENA_KMS_POLICY_SID);

const isKmsUpToDate = (statement: any | undefined): boolean =>
  Boolean(statement) && REQUIRED_ATHENA_KMS_ACTIONS.every((action) => statement.Action?.includes(action));

const buildAthenaStatement = (bucketName: string) => ({
  Sid: ATHENA_POLICY_SID,
  Effect: 'Allow',
  Principal: { AWS: AWS_ATHENA_ROLE_ARN },
  Action: REQUIRED_ATHENA_ACTIONS,
  Resource: [
    `arn:aws:s3:::${bucketName}`,
    `arn:aws:s3:::${bucketName}/*`,
  ],
});

const fetchCurrentPolicy = async (s3: S3Client, bucketName: string): Promise<BucketPolicy> => {
  try {
    const { Policy } = await s3.send(new GetBucketPolicyCommand({ Bucket: bucketName }));
    return JSON.parse(Policy!) as BucketPolicy;
  } catch (err: any) {
    if (err.name === 'NoSuchBucketPolicy') {
      return buildEmptyBucketPolicy();
    }
    throw err;
  }
};

// Our statement by SID, if the policy has one — regardless of whether it
// still carries every action we currently require (an older grant may only
// have the read-side actions from before Athena needed to write results).
const findAthenaStatement = (policy: BucketPolicy): any | undefined =>
  policy.Statement.find((statement) => statement.Sid === ATHENA_POLICY_SID);

const isUpToDate = (statement: any | undefined): boolean =>
  Boolean(statement) && REQUIRED_ATHENA_ACTIONS.every((action) => statement.Action?.includes(action));

const withRetries = async (fn: (attempt: number) => Promise<void>): Promise<void> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= POLICY_UPDATE_MAX_RETRIES; attempt++) {
    try {
      await fn(attempt);
      return;
    } catch (err: any) {
      lastError = err;

      if (attempt < POLICY_UPDATE_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  throw lastError;
};

// Checks whether the client's bucket policy already carries our Athena statement
// with every currently required action. Used when the client claims they
// granted access manually — we verify rather than modify their policy.
// Uses the CLIENT'S credentials.
export const checkAthenaRoleS3Access = async (creds: IS3Config): Promise<boolean> => {
  const { bucketName, region, accessKeyId, secretAccessKey } = creds;
  const credentials = { accessKeyId, secretAccessKey };

  const s3 = new S3Client({ region, credentials });

  const currentPolicy = await fetchCurrentPolicy(s3, bucketName);
  if (!isUpToDate(findAthenaStatement(currentPolicy))) {
    return false;
  }

  const keyId = await resolveBucketKmsKeyId(s3, bucketName);
  if (!keyId) {
    return true;
  }

  const kms = new KMSClient({ region, credentials });
  const currentKeyPolicy = await fetchCurrentKeyPolicy(kms, keyId);
  return isKmsUpToDate(findAthenaKmsStatement(currentKeyPolicy));
};

// Grants our Athena Role ARN the required access on the client's S3 bucket by
// upserting a single statement in their existing bucket policy.
//
// Safe merge pattern (AWS recommended for bucket policy updates):
//   1. Fetch the current policy (empty doc if none exists).
//   2. Check if our SID is already present AND covers every required action —
//      return early if so (idempotent). An older grant missing a newly
//      required action (e.g. a pre-existing read-only grant now that Athena
//      also writes results) falls through to step 3 and gets replaced in place.
//   3. Upsert our statement by SID, leaving all other statements untouched.
//   4. Write back. Retry the full cycle on transient errors up to MAX_RETRIES.
//
// If the bucket's default encryption is SSE-KMS/DSSE-KMS, the same upsert
// pattern is applied to the KMS key's own key policy — a bucket policy has no
// authority over KMS actions, so kms:Decrypt/kms:DescribeKey have to be
// granted there instead, as a separate statement on a separate resource.
//
// Uses the CLIENT'S credentials — only the bucket/key owner can modify these.
export const grantAthenaRoleS3Access = async (creds: IS3Config): Promise<void> => {
  const { bucketName, region, accessKeyId, secretAccessKey } = creds;
  const credentials = { accessKeyId, secretAccessKey };

  const s3 = new S3Client({ region, credentials });

  await withRetries(async () => {
    const currentPolicy = await fetchCurrentPolicy(s3, bucketName);

    if (isUpToDate(findAthenaStatement(currentPolicy))) {
      return;
    }

    const withoutOurs = currentPolicy.Statement.filter((s) => s.Sid !== ATHENA_POLICY_SID);
    const updatedPolicy: BucketPolicy = {
      ...currentPolicy,
      Statement: [...withoutOurs, buildAthenaStatement(bucketName)],
    };

    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: JSON.stringify(updatedPolicy),
        // Prevents accidentally locking the bucket owner out of their own bucket.
        // AWS requires this flag when the new policy would deny bucket owner access.
        ConfirmRemoveSelfBucketAccess: false,
      })
    );
  });

  const keyId = await resolveBucketKmsKeyId(s3, bucketName);
  if (!keyId) {
    return;
  }

  const kms = new KMSClient({ region, credentials });

  await withRetries(async () => {
    const currentKeyPolicy = await fetchCurrentKeyPolicy(kms, keyId);

    if (isKmsUpToDate(findAthenaKmsStatement(currentKeyPolicy))) {
      return;
    }

    const withoutOurs = currentKeyPolicy.Statement.filter((s) => s.Sid !== ATHENA_KMS_POLICY_SID);
    const updatedKeyPolicy: KeyPolicy = {
      ...currentKeyPolicy,
      Statement: [...withoutOurs, buildAthenaKmsStatement()],
    };

    await kms.send(
      new PutKeyPolicyCommand({
        KeyId: keyId,
        PolicyName: 'default',
        Policy: JSON.stringify(updatedKeyPolicy),
      })
    );
  });
};
