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
import { readHudiTableSchema } from './hudi-schema';

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
    logger.info(`[glue] created database | db:${databaseName}`);
  } catch (err: any) {
    if (err.name !== 'AlreadyExistsException') {
      logger.error(
        `[glue] ensureGlueDatabase failed | db:${databaseName} err:${err.name}: ${err.message}`
      );
      throw err;
    }
    logger.info(`[glue] database already exists | db:${databaseName}`);
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
    logger.error(
      `[glue] glueTableExists failed | db:${databaseName} table:${tableName} err:${err.name}: ${err.message}`
    );
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

  logger.info(
    `[glue] createCsvGlueTable start | db:${databaseName} table:${tableName} type:${type} columns:${columns.length}`
  );

  await ensureGlueDatabase(databaseName);

  const exists = await glueTableExists(databaseName, tableName);
  if (exists) {
    logger.info(
      `[glue] table already exists, skipping create | db:${databaseName} table:${tableName}`
    );
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

  logger.info(
    `[glue] registerBackupJobPartition start | table:${tableName} backupJobId:${backupJobId} type:${type}`
  );

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
      logger.info(
        `[glue] partition already exists | table:${tableName} backupJobId:${backupJobId}`
      );
      return;
    }
    logger.error(
      `[glue] registerBackupJobPartition failed | table:${tableName} backupJobId:${backupJobId} err:${err.name}: ${err.message}`
    );
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

  logger.info(
    `[glue] updateGlueTableSchema start | db:${databaseName} table:${tableName} columns:${columns.length}`
  );

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
export const repairGlueTableParams = async (params: IRepairGlueTableParamsInput): Promise<void> => {
  const { crmId, backupConfigId, objectName } = params;

  const databaseName = buildGlueDatabaseName(crmId);
  const tableName = buildGlueTableName(backupConfigId, objectName);

  logger.info(`[glue] repairGlueTableParams start | db:${databaseName} table:${tableName}`);

  const { Table } = await glue.send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );

  if (!Table) {
    logger.warn(
      `[glue] repairGlueTableParams: table not found | db:${databaseName} table:${tableName}`
    );
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

// ===========================================================================
// Current-State Hudi + Delta Glue tables (compression output)
// ===========================================================================
//
// Both are Hudi Copy-on-Write datasets Spark writes after compressing the raw
// CSVs. Node does NOT write the data — it only ensures the Glue table exists so
// Athena can read it. Tables are created ONCE and never updated: schema/location
// are read straight from the committed `.hoodie` metadata (see hudi-schema.ts),
// so the table always matches what Spark wrote.
//
// Layout (backup pipeline only — archival is a separate workflow):
//   Hudi : <crmName>/<crmId>/backup/<cfg>/main_backup_files/<Object>/
//   Delta: <crmName>/<crmId>/backup/<cfg>/delta/<Object>/

// Hudi CoW read format for Athena — parquet data read through Hudi's input format.
const HUDI_STORAGE_DESCRIPTOR_BASE = {
  InputFormat: 'org.apache.hudi.hadoop.HoodieParquetInputFormat',
  OutputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
  SerdeInfo: {
    SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
  },
  Compressed: false,
  NumberOfBuckets: -1,
} as const;

// Distinct table names so the Hudi/Delta tables never collide with the CSV table
// (cfg_<cfg>_<obj>).
const buildHudiTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_hudi`;

const buildDeltaTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_delta`;

// S3 key prefix (no bucket) of a compression-output table root.
const buildCompressionRootKey = (
  crmName: string,
  crmId: string,
  backupConfigId: string,
  objectName: string,
  dataset: 'main_backup_files' | 'delta'
): string => `${crmName}/${crmId}/backup/${backupConfigId}/${dataset}/${objectName}/`;

export interface IEnsureCompressionTableParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  destConfig: IDestinationConfig;
}

// Creates one Hudi-format Glue table, idempotently. Reads the committed schema
// from `.hoodie` on the client bucket, then creates the table pointing at the
// dataset root. Returns false (no-op) when the table already exists.
const ensureHudiFormatTable = async (
  params: IEnsureCompressionTableParams & {
    tableName: string;
    dataset: 'main_backup_files' | 'delta';
  }
): Promise<boolean> => {
  const { crmId, crmName, backupConfigId, objectName, destConfig, tableName, dataset } = params;

  const databaseName = buildGlueDatabaseName(crmId);

  logger.info(
    `[glue] ensure ${dataset === 'delta' ? 'delta' : 'hudi'} table start | db:${databaseName} table:${tableName}`
  );

  await ensureGlueDatabase(databaseName);

  if (await glueTableExists(databaseName, tableName)) {
    logger.info(
      `[glue] ${dataset === 'delta' ? 'delta' : 'hudi'} table already exists, skipping | db:${databaseName} table:${tableName}`
    );
    return false;
  }

  const rootKey = buildCompressionRootKey(crmName, crmId, backupConfigId, objectName, dataset);
  // Authoritative: matches exactly what Spark committed. Throws if not written yet.
  const { columns, partitionKeys } = await readHudiTableSchema(destConfig, rootKey);

  // Both tables are partitioned by year/month (Hive-style folders) and carry
  // backup_job_id as a data column. Guarantee all three regardless of what the
  // reader found, and keep the invariant that a name is never both a partition
  // key and a data column (Hive/Athena reject that).
  const PARTITION_NAMES = new Set(['year', 'month']);
  const finalPartitionKeys = [
    ...partitionKeys.filter((p) => !PARTITION_NAMES.has(p.name.toLowerCase())),
    { name: 'year', type: 'string' },
    { name: 'month', type: 'string' },
  ];
  const partitionNameSet = new Set(finalPartitionKeys.map((p) => p.name.toLowerCase()));

  const glueColumns: Column[] = [
    // Drop anything the reader surfaced that is actually a partition column, plus
    // any pre-existing backup_job_id so it isn't added twice.
    ...columns.filter(
      (c) => !partitionNameSet.has(c.name.toLowerCase()) && c.name.toLowerCase() !== 'backup_job_id'
    ),
    { name: 'backup_job_id', type: 'string' },
  ].map(({ name, type, comment }) => ({
    Name: name,
    Type: type,
    ...(comment ? { Comment: comment } : {}),
  }));

  try {
    await glue.send(
      new CreateTableCommand({
        DatabaseName: databaseName,
        TableInput: {
          Name: tableName,
          PartitionKeys: finalPartitionKeys.map((p) => ({ Name: p.name, Type: p.type })),
          StorageDescriptor: {
            ...HUDI_STORAGE_DESCRIPTOR_BASE,
            Columns: glueColumns,
            Location: `s3://${destConfig.bucketName}/${rootKey}`,
          },
          Parameters: {
            classification: 'parquet',
            // Let Athena use Hudi's file-listing index for partition discovery so a
            // partitioned table (e.g. delta) is queryable without a separate
            // ADD PARTITION step. No-op unless Spark wrote with the metadata table
            // enabled; harmless either way.
            'hudi.metadata-listing-enabled': 'TRUE',
          },
          TableType: 'EXTERNAL_TABLE',
        },
      })
    );
  } catch (err: any) {
    // Concurrent completion events can both pass the GetTable check and race here.
    // The loser sees AlreadyExistsException — the table exists, so treat as success.
    if (err.name === 'AlreadyExistsException') {
      logger.info(
        `[glue] ${dataset === 'delta' ? 'delta' : 'hudi'} table created concurrently | db:${databaseName} table:${tableName}`
      );
      return false;
    }
    logger.error(
      `[glue] ensure ${dataset === 'delta' ? 'delta' : 'hudi'} table failed | db:${databaseName} table:${tableName} err:${err.name}: ${err.message}`
    );
    throw err;
  }

  logger.info(
    `[glue] created ${dataset === 'delta' ? 'delta' : 'hudi'} table | db:${databaseName} table:${tableName} columns:${glueColumns.length} partitions:${finalPartitionKeys.length}`
  );
  return true;
};

// Ensures the current-state Hudi Glue table exists for one object. Idempotent.
export const ensureHudiCurrentStateTable = async (
  params: IEnsureCompressionTableParams
): Promise<boolean> =>
  ensureHudiFormatTable({
    ...params,
    tableName: buildHudiTableName(params.backupConfigId, params.objectName),
    dataset: 'main_backup_files',
  });

// Ensures the Delta Glue table exists for one object. Idempotent.
export const ensureDeltaTable = async (params: IEnsureCompressionTableParams): Promise<boolean> =>
  ensureHudiFormatTable({
    ...params,
    tableName: buildDeltaTableName(params.backupConfigId, params.objectName),
    dataset: 'delta',
  });
