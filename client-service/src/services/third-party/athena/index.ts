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

// Prefix under the client's own bucket that Athena writes query result files
// to (see restore-retrieve/index.ts's resolveAthenaOutputLocation, which
// builds the s3:// URI from this same constant) — kept isolated from the
// client's actual backup/archival data so the lifecycle rule below can
// expire result files without ever being able to reach real data, no matter
// what that data's own prefix layout is.
export const ATHENA_RESULTS_PREFIX = 'athena-query-results/';

// Client buckets need both read (source data Athena scans) and write (query
// result files landing under ATHENA_RESULTS_PREFIX, in the client's own
// bucket rather than Athena-owned managed storage — see athena/query.ts) access.
//   s3:GetObject        — read individual objects (Athena query execution)
//   s3:ListBucket        — list prefixes (Athena partition discovery)
//   s3:PutObject         — write query result files
//   s3:GetBucketLocation — Athena needs the bucket's region before it can target it
const REQUIRED_ATHENA_ACTIONS = ['s3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:GetBucketLocation'];

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

// Checks whether the client's bucket policy already carries our Athena statement
// with every currently required action. Used when the client claims they
// granted access manually — we verify rather than modify their policy.
// Uses the CLIENT'S credentials.
export const checkAthenaRoleS3Access = async (creds: IS3Config): Promise<boolean> => {
  const { bucketName, region, accessKeyId, secretAccessKey } = creds;

  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  const currentPolicy = await fetchCurrentPolicy(s3, bucketName);
  return isUpToDate(findAthenaStatement(currentPolicy));
};

// Grants our Athena Role ARN the required access on the client's S3 bucket by
// upserting a single statement in their existing bucket policy.
//
// ponytail: result files under ATHENA_RESULTS_PREFIX are never expired here —
// no S3 lifecycle permissions available yet. Add an
// s3:PutLifecycleConfiguration-scoped rule (Filter: {Prefix: ATHENA_RESULTS_PREFIX})
// once granted, so files don't accumulate in the client's bucket indefinitely.
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

      if (isUpToDate(findAthenaStatement(currentPolicy))) {
        logger.info(`[athena] Athena role already has S3 access | bucket:${bucketName}`);
        return;
      }

      // Upsert our statement by SID — replaces a stale grant in place,
      // appends a new one otherwise. All other statements are preserved.
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
