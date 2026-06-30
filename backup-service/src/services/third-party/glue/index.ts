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
  AWS_GLUE_ACCESS_KEY,
  AWS_GLUE_SECRET_KEY,
  AWS_GLUE_DATABASE_PREFIX,
} from '../../../constant';
import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';

// Platform-owned Glue client — always uses our own AWS credentials,
// never the customer's destination bucket credentials.
const glue = new GlueClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_GLUE_ACCESS_KEY,
    secretAccessKey: AWS_GLUE_SECRET_KEY,
  },
});

// Glue identifiers (database/table names) only allow lowercase letters,
// numbers, and underscores. Sanitize any input before using it as an identifier.
const toGlueIdentifier = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Multi-tenancy: one Glue database per crmId so each tenant's tables are
// fully isolated. Prefix keeps all platform databases grouped together.
//   e.g.  datavault_00d1b000001abc
const buildGlueDatabaseName = (crmId: string): string =>
  `${toGlueIdentifier(AWS_GLUE_DATABASE_PREFIX)}_${toGlueIdentifier(crmId)}`;

// Table name encodes backupConfigId + objectApiName for uniqueness within the
// tenant database.
//   e.g.  cfg_abc123_account
const buildGlueTableName = (backupConfigId: string, objectName: string): string =>
  `cfg_${toGlueIdentifier(backupConfigId)}_${toGlueIdentifier(objectName)}`;

// Builds the S3 URI root for a table — points to raw_data/ above all backupJobId
// sub-folders so the single Glue table spans every job for this config + object.
//   e.g. s3://client-bucket/salesforce/00d1b/archival/cfg123/raw_data/
const buildTableS3Root = (
  destConfig: IDestinationConfig,
  crmName: string,
  crmId: string,
  type: string,
  backupConfigId: string
): string =>
  `s3://${destConfig.bucketName}/${crmName}/${crmId}/${type}/${backupConfigId}/raw_data/`;

// Builds the S3 URI for one backupJobId partition within the table root.
//   e.g. s3://client-bucket/salesforce/00d1b/archival/cfg123/raw_data/job456/Account/
const buildPartitionS3Location = (
  destConfig: IDestinationConfig,
  crmName: string,
  crmId: string,
  type: string,
  backupConfigId: string,
  backupJobId: string,
  objectName: string
): string =>
  `s3://${destConfig.bucketName}/${crmName}/${crmId}/${type}/${backupConfigId}/raw_data/${backupJobId}/${objectName}/`;

// Ensures the Glue database exists. Creates it if not — idempotent.
const ensureGlueDatabase = async (databaseName: string): Promise<void> => {
  try {
    await glue.send(new CreateDatabaseCommand({ DatabaseInput: { Name: databaseName } }));
  } catch (err: any) {
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

// The SerDe + format settings shared between CreateTable, UpdateTable, and
// partition registration — kept in one place so they never drift apart.
const CSV_STORAGE_DESCRIPTOR_BASE = {
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
} as const;

const CSV_TABLE_PARAMETERS = {
  'skip.header.line.count': '1',
  classification: 'csv',
  // Recurse into sub-folders (inserts/, updates/, deletes/) within each partition prefix.
  recurse: '1',
} as const;

export interface IGlueColumnDef {
  name: string;
  // Glue type string — e.g. 'string', 'bigint', 'double', 'boolean', 'timestamp'
  type: string;
  comment?: string;
}

export interface ICreateCsvGlueTableParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  // 'archival' | 'backup' — determines the S3 path segment
  type: string;
  destConfig: IDestinationConfig;
  // Column definitions derived from the object's field metadata.
  // backupJobId must NOT be included — it is the partition key, not a data column.
  columns: IGlueColumnDef[];
}

export interface IRegisterBackupJobPartitionParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  backupJobId: string;
  type: string;
  destConfig: IDestinationConfig;
}

export interface IUpdateGlueTableSchemaParams {
  crmId: string;
  backupConfigId: string;
  objectName: string;
  // New complete column list — Glue replaces all columns, not just the changed ones.
  // backupJobId must NOT be included here.
  columns: IGlueColumnDef[];
}

// Creates a Glue Catalog table for CSVs that live on the client's S3 bucket.
// Skips creation silently when the table already exists so retries are safe.
//
// Partitioning strategy:
//   The table root points to raw_data/ (above all backupJobId folders).
//   backupJobId is declared as the sole partition key so Athena can prune reads
//   to only the job(s) a query cares about — queries use WHERE backup_job_id = '...'
//   New partitions are registered explicitly via registerBackupJobPartition after
//   each upload completes — no MSCK REPAIR TABLE needed.
//
// Multi-tenancy isolation:
//   - Database: datavault_<crmId>                    (one per tenant CRM)
//   - Table:    cfg_<backupConfigId>_<objectName>    (one per config × object)
export const createCsvGlueTable = async (params: ICreateCsvGlueTableParams): Promise<void> => {
  const { crmId, crmName, backupConfigId, objectName, type, destConfig, columns } = params;

  const databaseName = buildGlueDatabaseName(crmId);
  const tableName = buildGlueTableName(backupConfigId, objectName);

  await ensureGlueDatabase(databaseName);

  const exists = await glueTableExists(databaseName, tableName);
  if (exists) {
    return;
  }

  const glueColumns: Column[] = columns.map(({ name, type: colType, comment }) => ({
    Name: toGlueIdentifier(name),
    Type: colType,
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
          ...CSV_STORAGE_DESCRIPTOR_BASE,
          Columns: glueColumns,
          Location: buildTableS3Root(destConfig, crmName, crmId, type, backupConfigId),
        },
        Parameters: { ...CSV_TABLE_PARAMETERS },
        TableType: 'EXTERNAL_TABLE',
      },
    })
  );

  logger.info(
    `[glue] created table | db:${databaseName} table:${tableName} columns:${glueColumns.length}`
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
  const { crmId, crmName, backupConfigId, objectName, backupJobId, type, destConfig } = params;

  const databaseName = buildGlueDatabaseName(crmId);
  const tableName = buildGlueTableName(backupConfigId, objectName);

  const partitionInput: PartitionInput = {
    Values: [backupJobId],
    StorageDescriptor: {
      ...CSV_STORAGE_DESCRIPTOR_BASE,
      Location: buildPartitionS3Location(
        destConfig,
        crmName,
        crmId,
        type,
        backupConfigId,
        backupJobId,
        objectName
      ),
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
// columns that did not exist when those files were created — expected Hive behaviour.
export const updateGlueTableSchema = async (
  params: IUpdateGlueTableSchemaParams
): Promise<void> => {
  const { crmId, backupConfigId, objectName, columns } = params;

  const databaseName = buildGlueDatabaseName(crmId);
  const tableName = buildGlueTableName(backupConfigId, objectName);

  const glueColumns: Column[] = columns.map(({ name, type, comment }) => ({
    Name: toGlueIdentifier(name),
    Type: type,
    ...(comment ? { Comment: comment } : {}),
  }));

  // UpdateTable requires the full StorageDescriptor including Location.
  // We fetch the current table to preserve the original Location rather than
  // rebuilding it (the bucket/path may have been set with a folder prefix).
  const { Table } = await glue.send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );

  await glue.send(
    new UpdateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: tableName,
        PartitionKeys: [{ Name: 'backup_job_id', Type: 'string' }],
        StorageDescriptor: {
          ...CSV_STORAGE_DESCRIPTOR_BASE,
          Columns: glueColumns,
          // Preserve the original root location set at table creation.
          Location: Table?.StorageDescriptor?.Location ?? '',
        },
        Parameters: { ...(Table?.Parameters ?? {}), ...CSV_TABLE_PARAMETERS },
        TableType: 'EXTERNAL_TABLE',
      },
    })
  );

  logger.info(`[glue] updated table schema | table:${tableName} columns:${glueColumns.length}`);
};

export interface IRepairGlueTableParamsInput {
  crmId: string;
  backupConfigId: string;
  objectName: string;
}

// Patches an existing Glue table to add any missing table parameters (e.g. recurse=1)
// without touching columns, partition keys, or storage location.
// Call this once per table for tables created before recurse=1 was added.
export const repairGlueTableParams = async (
  params: IRepairGlueTableParamsInput
): Promise<void> => {
  const { crmId, backupConfigId, objectName } = params;

  const databaseName = buildGlueDatabaseName(crmId);
  const tableName = buildGlueTableName(backupConfigId, objectName);

  const { Table } = await glue.send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );

  if (!Table) {
    logger.warn(`[glue] repairGlueTableParams: table not found | db:${databaseName} table:${tableName}`);
    return;
  }

  await glue.send(
    new UpdateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: tableName,
        PartitionKeys: Table.PartitionKeys ?? [],
        StorageDescriptor: {
          ...Table.StorageDescriptor,
          SerdeInfo: Table.StorageDescriptor?.SerdeInfo ?? {},
        },
        Parameters: { ...(Table.Parameters ?? {}), ...CSV_TABLE_PARAMETERS },
        TableType: Table.TableType ?? 'EXTERNAL_TABLE',
      },
    })
  );

  logger.info(`[glue] repaired table params | db:${databaseName} table:${tableName}`);
};
