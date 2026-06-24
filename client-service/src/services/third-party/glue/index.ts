import {
  GlueClient,
  CreateDatabaseCommand,
  CreateTableCommand,
  GetTableCommand,
  UpdateTableCommand,
  BatchCreatePartitionCommand,
  EntityNotFoundException,
  Column,
  PartitionInput,
} from '@aws-sdk/client-glue';
import {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_GLUE_DATABASE_PREFIX,
} from '../../../constant';
import { logger } from '../../../middlewares';

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

export interface IUpdateGlueTableSchemaParams {
  crmId: string;
  backupConfigId: string;
  objectApiName: string;
  // New column set derived from the updated CSV header.
  // Must NOT include backupJobId — that remains a partition key, not a data column.
  columns: IGlueColumnDef[];
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
    logger.info(`[glue] registered partition | table:${tableName} backupJobId:${backupJobId}`);
  } catch (err: any) {
    // AlreadyExistsException from BatchCreatePartition surfaces inside the response
    // errors array, not as a thrown exception — but guard the thrown path too.
    if (err.name === 'AlreadyExistsException') {
      return;
    }
    throw err;
  }
};

// Updates the column definitions on an existing Glue table when the object's
// schema changes (new fields added, types changed, fields removed).
//
// Glue's UpdateTable does a full replacement of StorageDescriptor.Columns, so
// the caller must pass the complete new column list — not just the diff.
// The partition key (backup_job_id) and all SerDe / format settings are
// preserved exactly as they were set at table-creation time.
//
// Athena queries issued after this call will use the new column definitions.
// Older partitions written under the previous schema may return nulls for
// columns that did not exist when those files were created — this is expected
// Hive behaviour and is not an error.
export const updateGlueTableSchema = async (params: IUpdateGlueTableSchemaParams): Promise<void> => {
  const { crmId, backupConfigId, objectApiName, columns } = params;

  const databaseName = buildDatabaseName(crmId);
  const tableName = buildTableName(backupConfigId, objectApiName);

  const glueColumns: Column[] = columns.map(({ name, type, comment }) => ({
    Name: toGlueIdentifier(name),
    Type: type,
    ...(comment ? { Comment: comment } : {}),
  }));

  await glue.send(
    new UpdateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: tableName,
        PartitionKeys: [{ Name: 'backup_job_id', Type: 'string' }],
        StorageDescriptor: {
          Columns: glueColumns,
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
          'skip.header.line.count': '1',
          classification: 'csv',
        },
        TableType: 'EXTERNAL_TABLE',
      },
    })
  );

  logger.info(`[glue] updated table schema | table:${tableName} columns:${glueColumns.length}`);
};
