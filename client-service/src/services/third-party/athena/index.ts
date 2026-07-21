import {
  S3Client,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { AWS_ATHENA_ROLE_ARN } from '../../../constant';
import { logger } from '../../../middlewares';
import { IS3Config } from '../../../models';

// SID stamped on our statement so we can detect and skip re-adding it.
const ATHENA_POLICY_SID = 'DataVaultAthenaRoleAccess';

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

const buildAthenaStatement = (bucketName: string) => ({
  Sid: ATHENA_POLICY_SID,
  Effect: 'Allow',
  Principal: { AWS: AWS_ATHENA_ROLE_ARN },
  // s3:GetObject  — read individual objects (Athena query execution)
  // s3:ListBucket — list prefixes (Athena partition discovery)
  Action: ['s3:GetObject', 's3:ListBucket'],
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

const hasAthenaStatement = (policy: BucketPolicy): boolean =>
  policy.Statement.some((statement) => statement.Sid === ATHENA_POLICY_SID);

// Checks whether the client's bucket policy already carries our Athena statement.
// Used when the client claims they granted access manually — we verify rather
// than modify their policy. Uses the CLIENT'S credentials.
export const checkAthenaRoleS3Access = async (creds: IS3Config): Promise<boolean> => {
  const { bucketName, region, accessKeyId, secretAccessKey } = creds;

  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  const currentPolicy = await fetchCurrentPolicy(s3, bucketName);
  return hasAthenaStatement(currentPolicy);
};

// Grants our Athena Role ARN read access on the client's S3 bucket by
// appending a single statement to their existing bucket policy.
//
// Safe merge pattern (AWS recommended for bucket policy updates):
//   1. Fetch the current policy (empty doc if none exists).
//   2. Check if our SID is already present — return early if so (idempotent).
//   3. Append only our statement, leaving all existing statements untouched.
//   4. Write back. Retry the full cycle on transient errors up to MAX_RETRIES.
//
// Uses the CLIENT'S credentials — only the bucket owner can modify their policy.
export const grantAthenaRoleS3Access = async (creds: IS3Config): Promise<void> => {
  const { bucketName, region, accessKeyId, secretAccessKey } = creds;

  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  let lastError: unknown;

  for (let attempt = 1; attempt <= POLICY_UPDATE_MAX_RETRIES; attempt++) {
    try {
      const currentPolicy = await fetchCurrentPolicy(s3, bucketName);

      if (hasAthenaStatement(currentPolicy)) {
        logger.info(`[athena] Athena role already has S3 access | bucket:${bucketName}`);
        return;
      }

      // Append only our statement — all existing client statements are preserved.
      const updatedPolicy: BucketPolicy = {
        ...currentPolicy,
        Statement: [...currentPolicy.Statement, buildAthenaStatement(bucketName)],
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

      logger.info(`[athena] granted Athena role S3 access | bucket:${bucketName} attempt:${attempt}`);
      return;
    } catch (err: any) {
      lastError = err;
      logger.warn(`[athena] policy update attempt ${attempt}/${POLICY_UPDATE_MAX_RETRIES} failed | bucket:${bucketName} err:${err?.message ?? err}`);

      if (attempt < POLICY_UPDATE_MAX_RETRIES) {
        // Brief back-off before retrying the full fetch→merge→put cycle.
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  throw lastError;
};
