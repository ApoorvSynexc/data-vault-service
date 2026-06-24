import {
  GlueClient,
  CreateDatabaseCommand,
  CreateTableCommand,
  GetTableCommand,
  BatchCreatePartitionCommand,
  EntityNotFoundException,
  Column,
  PartitionInput,
} from '@aws-sdk/client-glue';
import {
  S3Client,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_GLUE_DATABASE_PREFIX,
  AWS_ATHENA_ROLE_ARN,
} from '../../../constant';
import { logger } from '../../../middlewares';
import { IS3Config } from '../../../models';

// Platform-owned Glue client — always uses our own AWS credentials,
// never the customer's destination bucket credentials.
const glue = new GlueClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// Glue identifiers (database/table names) only allow lowercase letters,
// numbers, and underscores. Sanitize any input before using it as an identifier.
const toGlueIdentifier = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Multi-tenancy: one Glue database per crmId so each tenant's tables are
// fully isolated. Prefix keeps all platform databases grouped together.
//   e.g.  datavault_00d1b000001abc
const buildDatabaseName = (crmId: string): string =>
  `${toGlueIdentifier(AWS_GLUE_DATABASE_PREFIX)}_${toGlueIdentifier(crmId)}`;

// Table name encodes backupConfigId + objectApiName for uniqueness within the
// tenant database.
//   e.g.  cfg_abc123_account
const buildTableName = (backupConfigId: string, objectApiName: string): string =>
  `cfg_${toGlueIdentifier(backupConfigId)}_${toGlueIdentifier(objectApiName)}`;

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

// Ensures the Glue database exists. Creates it if not — idempotent.
const ensureGlueDatabase = async (databaseName: string): Promise<void> => {
  try {
    await glue.send(
      new CreateDatabaseCommand({
        DatabaseInput: { Name: databaseName },
      })
    );
  } catch (err: any) {
    // AlreadyExistsException means the database is already there — not an error.
    if (err.name !== 'AlreadyExistsException') {
      throw err;
    }
  }
};

// Returns true when the Glue table already exists, false otherwise.
const glueTableExists = async (databaseName: string, tableName: string): Promise<boolean> => {
  try {
    await glue.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    return true;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err.name === 'EntityNotFoundException') {
      return false;
    }
    throw err;
  }
};

export interface IGlueColumnDef {
  name: string;
  // Glue type string — e.g. 'string', 'bigint', 'double', 'boolean', 'timestamp'
  type: string;
  comment?: string;
}

export interface ICreateCsvGlueTableParams {
  crmId: string;
  backupConfigId: string;
  objectApiName: string;
  // Root S3 location above all backupJobId folders on the client's destination bucket.
  // e.g. s3://<clientBucket>/<crmName>/<crmId>/<type>/<backupConfigId>/raw_data/
  // Individual job partitions are registered separately via registerBackupJobPartition.
  s3RootLocation: string;
  // Column definitions derived from the CSV header — crmId / backupConfigId /
  // objectApiName / backupJobId are NOT data columns and must NOT appear here.
  columns: IGlueColumnDef[];
}

export interface IRegisterBackupJobPartitionParams {
  crmId: string;
  backupConfigId: string;
  objectApiName: string;
  backupJobId: string;
  // Full S3 location for this specific job's CSV files.
  // e.g. s3://<clientBucket>/<crmName>/<crmId>/<type>/<backupConfigId>/raw_data/<backupJobId>/<objectName>/
  s3PartitionLocation: string;
}

// Creates a Glue Catalog table for CSVs that live on the client's S3 bucket.
// Skips creation silently when the table already exists so retries are safe.
//
// Partitioning strategy:
//   The table root points to raw_data/ (above all backupJobId folders).
//   backupJobId is declared as the sole partition key so Athena can prune reads
//   to only the job(s) a query cares about — queries use WHERE backup_job_id = '...'
//   and Athena skips every other job's S3 prefix entirely.
//   New partitions are registered explicitly via registerBackupJobPartition after
//   each upload completes — no MSCK REPAIR TABLE needed.
//
// Multi-tenancy isolation:
//   - Database: datavault_<crmId>                    (one per tenant CRM)
//   - Table:    cfg_<backupConfigId>_<objectApiName> (one per config × object)
//
// CSV SerDe:
//   - quoteChar '"'  — standard quoted-field handling
//   - escapeChar '\' — backslash escaping inside quoted fields
//   - skip.header.line.count 1 — Glue ignores the CSV header row on read
export const createCsvGlueTable = async (params: ICreateCsvGlueTableParams): Promise<void> => {
  const { crmId, backupConfigId, objectApiName, s3RootLocation, columns } = params;

  const databaseName = buildDatabaseName(crmId);
  const tableName = buildTableName(backupConfigId, objectApiName);

  await ensureGlueDatabase(databaseName);

  const exists = await glueTableExists(databaseName, tableName);
  if (exists) {
    return;
  }

  const glueColumns: Column[] = columns.map(({ name, type, comment }) => ({
    Name: toGlueIdentifier(name),
    Type: type,
    ...(comment ? { Comment: comment } : {}),
  }));

  await glue.send(
    new CreateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: tableName,
        // backupJobId is the partition key — not a data column.
        // Athena uses it to restrict S3 reads to the relevant job prefix.
        PartitionKeys: [{ Name: 'backup_job_id', Type: 'string' }],
        StorageDescriptor: {
          Columns: glueColumns,
          Location: s3RootLocation,
          InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          SerdeInfo: {
            SerializationLibrary: 'org.apache.hadoop.hive.serde2.OpenCSVSerde',
            Parameters: {
              separatorChar: ',',
              quoteChar: '"',
              escapeChar: '\\',
            },
          },
          Compressed: false,
          NumberOfBuckets: -1,
        },
        Parameters: {
          // Glue skips the first row (the CSV header) on read.
          'skip.header.line.count': '1',
          classification: 'csv',
        },
        TableType: 'EXTERNAL_TABLE',
      },
    })
  );
};

// Registers a new backupJobId partition in the Glue Catalog after a backup job
// finishes uploading its CSVs. This tells Athena exactly which S3 prefix to read
// for that job — no MSCK REPAIR TABLE needed.
//
// Idempotent: AlreadyExistsException is swallowed so retries are safe.
export const registerBackupJobPartition = async (
  params: IRegisterBackupJobPartitionParams
): Promise<void> => {
  const { crmId, backupConfigId, objectApiName, backupJobId, s3PartitionLocation } = params;

  const databaseName = buildDatabaseName(crmId);
  const tableName = buildTableName(backupConfigId, objectApiName);

  const partitionInput: PartitionInput = {
    Values: [backupJobId],
    StorageDescriptor: {
      Location: s3PartitionLocation,
      InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
      OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
      SerdeInfo: {
        SerializationLibrary: 'org.apache.hadoop.hive.serde2.OpenCSVSerde',
        Parameters: {
          separatorChar: ',',
          quoteChar: '"',
          escapeChar: '\\',
        },
      },
      Compressed: false,
      NumberOfBuckets: -1,
    },
  };

  try {
    await glue.send(
      new BatchCreatePartitionCommand({
        DatabaseName: databaseName,
        TableName: tableName,
        PartitionInputList: [partitionInput],
      })
    );
    logger.info(`[athena] registered partition | table:${tableName} backupJobId:${backupJobId}`);
  } catch (err: any) {
    // AlreadyExistsException from BatchCreatePartition surfaces inside the response
    // errors array, not as a thrown exception — but guard the thrown path too.
    if (err.name === 'AlreadyExistsException') {
      return;
    }
    throw err;
  }
};
