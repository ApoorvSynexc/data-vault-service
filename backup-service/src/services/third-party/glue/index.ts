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
import { AWS_REGION, AWS_ACCESS_KEY, AWS_SECRET_KEY } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import { IDestinationConfig, IAwsCredentials } from '../../../models';
import { SCHEMA_KIND_FILE } from '../../../utils/helper';
import { listS3Prefixes } from '../../destination/s3';
import { getStoredEntries } from '../salesforce/metadata/common';

const awsCredentials: IAwsCredentials = {
  region: AWS_REGION,
};

if (AWS_ACCESS_KEY && AWS_SECRET_KEY) {
  awsCredentials.credentials = {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
  };
}

const glue = new GlueClient(awsCredentials);

const toGlueIdentifier = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
const buildGlueDatabaseName = (backupConfigId: string): string => toGlueIdentifier(backupConfigId);
const buildGlueTableName = (backupConfigId: string, objectName: string): string =>
  `cfg_${toGlueIdentifier(backupConfigId)}_${toGlueIdentifier(objectName)}`;

const inFlightDatabaseCreate = new Map<string, Promise<void>>();

const ensureGlueDatabase = async (databaseName: string): Promise<void> => {
  const existing = inFlightDatabaseCreate.get(databaseName);
  if (existing) {
    logger.info(`[glue] ensureGlueDatabase duplicate | db:${databaseName} awaiting in-progress create`);
    return existing;
  }

  logger.info(`[glue] ensureGlueDatabase start | db:${databaseName}`);
  const create = (async () => {
    try {
      await glue.send(new CreateDatabaseCommand({ DatabaseInput: { Name: databaseName } }));
      logger.info(`[glue] created database | db:${databaseName}`);
    } catch (err: any) {
      if (err.name !== 'AlreadyExistsException') {
        logger.error(`[glue] ensureGlueDatabase failed | db:${databaseName} err:${err.name}: ${err.message}`);
        throw err;
      }
      logger.info(`[glue] database already exists | db:${databaseName}`);
    }
  })();
  inFlightDatabaseCreate.set(databaseName, create);

  try {
    await create;
    logger.info(`[glue] ensureGlueDatabase complete | db:${databaseName}`);
  } finally {
    inFlightDatabaseCreate.delete(databaseName);
  }
};

const glueTableExists = async (databaseName: string, tableName: string): Promise<boolean> => {
  try {
    await glue.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    return true;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err.name === 'EntityNotFoundException') {
      return false;
    }
    logger.error(`[glue] glueTableExists failed | db:${databaseName} table:${tableName} err:${err.name}: ${err.message}`);
    throw err;
  }
};

export interface IGlueColumnDef {
  name: string;
  type: string;
  comment?: string;
}

// Plain Parquet — both the current-state and delta tables are read as ordinary
// Parquet files, not through the Hudi connector (no HoodieParquetInputFormat,
// no athena_enable_native_hudi_connector_implementation / hudi.* table params).
const PARQUET_STORAGE_DESCRIPTOR_BASE = {
  InputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
  OutputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
  SerdeInfo: {
    SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
  },
  Compressed: false,
  NumberOfBuckets: -1,
} as const;

// Fixed schema for every object's delta table — same columns regardless of the
// Salesforce object, so there is nothing to derive from S3.
const DELTA_TABLE_COLUMNS: IGlueColumnDef[] = [
  { name: 'delta_id', type: 'string' },
  { name: 'change_time', type: 'string' },
  { name: 'record_id', type: 'string' },
  { name: 'change_type', type: 'string' },
  { name: 'change_data', type: 'string' },
  { name: 'is_schema_change', type: 'boolean' },
  { name: 'schema_change_type', type: 'string' },
  { name: 'schema_field_api_name', type: 'string' },
];

// Same key formula as metadata/field/index.ts:buildS3Key (metadataType 'fields')
// — that module is the writer, this just needs to land on the identical key.
export const buildMainFieldSchemaKey = (identity: {
  crmName: string;
  crmId: string;
  policyConfigType: 'backup' | 'archival';
  backupConfigId: string;
  objectName: string;
}): string => {
  const { crmName, crmId, policyConfigType, backupConfigId, objectName } = identity;
  return `${crmName}/${crmId}/${policyConfigType}/${backupConfigId}/schema/${objectName}/fields/${SCHEMA_KIND_FILE.fields}`;
};

// Picks the current field list out of the stored schema-version history and
// types every column as string (no Salesforce type inference). Pure: exported
// for the self-check below.
//
// The writer (metadata/field/index.ts:schemaHandler) appends one entry per
// schema version: the object's first-ever backup is tagged sourceType 'main',
// and every later entry — appended only when the schema actually drifted — is
// tagged 'changes'. Each entry's `context` is always the FULL field list as of
// that write, not a delta, so the last entry in the array is always today's
// schema: 'main' itself before anything has ever drifted, otherwise the newest
// 'changes' entry. Taking anything other than the last entry would freeze the
// Glue table's columns at the object's very first backup and never pick up
// fields added or removed afterward.
export const pickMainTableColumns = (
  entries: Array<{ context: Array<{ name: string }> }>,
  key: string
): IGlueColumnDef[] => {
  const latest = entries[entries.length - 1];
  if (!latest) {
    throw new Error(`no stored field schema under ${key}`);
  }
  return latest.context.map((field) => ({ name: field.name, type: 'string' }));
};

// The current-state table's columns come from the client's S3-stored field
// schema instead of a Hudi/Parquet footer inspection — see pickMainTableColumns.
const resolveMainTableColumns = async (
  destConfig: IDestinationConfig,
  identity: {
    crmName: string;
    crmId: string;
    policyConfigType: 'backup' | 'archival';
    backupConfigId: string;
    objectName: string;
  }
): Promise<IGlueColumnDef[]> => {
  const key = buildMainFieldSchemaKey(identity);
  const entries = await getStoredEntries<Array<{ name: string }>>(destConfig, key);
  return pickMainTableColumns(entries, key);
};

const buildHudiTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_hudi`;

const buildDeltaTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_delta`;

const DATASET_S3_FOLDER: Record<'main_backup_files' | 'delta', string> = {
  main_backup_files: 'main_backup_files',
  delta: 'deltas',
};

const buildCompressionRootKey = (
  crmName: string,
  crmId: string,
  backupConfigId: string,
  objectName: string,
  dataset: 'main_backup_files' | 'delta'
): string =>
  `${crmName}/${crmId}/backup/${backupConfigId}/${DATASET_S3_FOLDER[dataset]}/${objectName}/`;

export interface IEnsureCompressionTableParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  destConfig: IDestinationConfig;
  // 'backup' | 'archival' — which schema/ S3 prefix to read the current-state
  // table's column list from (see resolveMainTableColumns).
  policyConfigType: 'backup' | 'archival';
}

const syncHudiTablePartitions = async (
  databaseName: string,
  tableName: string,
  destConfig: IDestinationConfig,
  rootKey: string
): Promise<void> => {
  const partitionInputs: PartitionInput[] = [];

  const yearPrefixes = (await listS3Prefixes(destConfig, rootKey)).filter((p) =>
    /\/year=\d+\/$/.test(p)
  );
  for (const yearPrefix of yearPrefixes) {
    const monthPrefixes = (await listS3Prefixes(destConfig, yearPrefix)).filter((p) =>
      /\/month=\d+\/$/.test(p)
    );
    for (const monthPrefix of monthPrefixes) {
      const year = /year=(\d+)\//.exec(yearPrefix)![1];
      const month = /month=(\d+)\/$/.exec(monthPrefix)![1];
      partitionInputs.push({
        Values: [year, month],
        StorageDescriptor: {
          ...PARQUET_STORAGE_DESCRIPTOR_BASE,
          Location: `s3://${destConfig.bucketName}/${monthPrefix}`,
        },
      });
    }
  }

  if (partitionInputs.length === 0) {
    logger.info(`[glue] no hive-style partitions found on S3 | table:${tableName} root:${rootKey}`);
    return;
  }

  for (let i = 0; i < partitionInputs.length; i += 100) {
    const batch = partitionInputs.slice(i, i + 100);
    const result = await glue.send(
      new BatchCreatePartitionCommand({
        DatabaseName: databaseName,
        TableName: tableName,
        PartitionInputList: batch,
      })
    );
    const realErrors = (result.Errors ?? []).filter(
      (e) => e.ErrorDetail?.ErrorCode !== 'AlreadyExistsException'
    );
    if (realErrors.length) {
      logger.warn(
        `[glue] partition sync had errors | table:${tableName} errors:${JSON.stringify(realErrors)}`
      );
    }
  }

  logger.info(
    `[glue] partition sync complete | table:${tableName} partitions:${partitionInputs.length}`
  );
};

interface ITableIdentity {
  crmName: string;
  crmId: string;
  policyConfigType: 'backup' | 'archival';
  backupConfigId: string;
  objectName: string;
}

const resolveTableShape = async (
  destConfig: IDestinationConfig,
  identity: ITableIdentity,
  dataset: 'main_backup_files' | 'delta'
): Promise<{ glueColumns: Column[]; finalPartitionKeys: { name: string; type: string }[] }> => {
  const columns =
    dataset === 'delta' ? DELTA_TABLE_COLUMNS : await resolveMainTableColumns(destConfig, identity);

  // Both tables are always laid out on S3 as year=/month= partitions — see
  // buildCompressionRootKey / syncHudiTablePartitions.
  const finalPartitionKeys = [
    { name: 'year', type: 'string' },
    { name: 'month', type: 'string' },
  ];
  const partitionNameSet = new Set(finalPartitionKeys.map((p) => p.name.toLowerCase()));

  const glueColumns: Column[] = [
    ...columns.filter(
      (c) => !partitionNameSet.has(c.name.toLowerCase()) && c.name.toLowerCase() !== 'backup_job_id'
    ),
    { name: 'backup_job_id', type: 'string' },
  ].map(({ name, type, comment }) => ({
    Name: name,
    Type: type,
    ...(comment ? { Comment: comment } : {}),
  }));

  return { glueColumns, finalPartitionKeys };
};

const syncHudiTableSchema = async (
  databaseName: string,
  tableName: string,
  destConfig: IDestinationConfig,
  rootKey: string,
  identity: ITableIdentity,
  dataset: 'main_backup_files' | 'delta'
): Promise<void> => {
  const { glueColumns } = await resolveTableShape(destConfig, identity, dataset);
  const { Table } = await glue.send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );

  const signature = (cols: Column[] = []): string =>
    cols.map((c) => `${c.Name}:${c.Type}`).join(',');
  const columnsMatch = signature(Table?.StorageDescriptor?.Columns) === signature(glueColumns);
  const hasProjection = Table?.Parameters?.['projection.enabled'] === 'true';

  if (columnsMatch && hasProjection) {
    return;
  }

  await glue.send(
    new UpdateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: tableName,
        PartitionKeys: Table?.PartitionKeys ?? [],
        StorageDescriptor: {
          ...PARQUET_STORAGE_DESCRIPTOR_BASE,
          Columns: glueColumns,
          Location: Table?.StorageDescriptor?.Location ?? '',
        },
        Parameters: {
          ...(Table?.Parameters ?? {}),
          classification: 'parquet',
          // Partition Projection to skip Glue API partition fetches
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2020,2030',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'storage.location.template': `s3://${destConfig.bucketName}/${rootKey}year=\${year}/month=\${month}`,
        },
        TableType: Table?.TableType ?? 'EXTERNAL_TABLE',
      },
    })
  );

  logger.info(
    `[glue] refreshed table schema & performance properties | table:${tableName} columns:${glueColumns.length}`
  );
};

const ensureHudiFormatTable = async (
  params: IEnsureCompressionTableParams & {
    tableName: string;
    dataset: 'main_backup_files' | 'delta';
  }
): Promise<boolean> => {
  const { crmId, crmName, policyConfigType, backupConfigId, objectName, destConfig, tableName, dataset } =
    params;
  const identity: ITableIdentity = { crmId, crmName, policyConfigType, backupConfigId, objectName };

  const databaseName = buildGlueDatabaseName(backupConfigId);
  const label = dataset === 'main_backup_files' ? 'hudi' : dataset;

  logger.info(`[glue] ensure ${label} table start | db:${databaseName} table:${tableName}`);

  await ensureGlueDatabase(databaseName);

  const rootKey = buildCompressionRootKey(crmName, crmId, backupConfigId, objectName, dataset);

  const syncPartitions = (): Promise<void> =>
    syncHudiTablePartitions(databaseName, tableName, destConfig, rootKey).catch((err: any) => {
      logger.warn(
        `[glue] partition sync failed | table:${tableName} err:${err.name}: ${err.message}`
      );
    });

  if (await glueTableExists(databaseName, tableName)) {
    logger.info(
      `[glue] ${label} table already exists, syncing schema + partitions | db:${databaseName} table:${tableName}`
    );
    await syncHudiTableSchema(databaseName, tableName, destConfig, rootKey, identity, dataset).catch(
      (err: any) => {
        logger.warn(`[glue] schema sync failed | table:${tableName} err:${err.name}: ${err.message}`);
      }
    );
    await syncPartitions();
    return false;
  }

  const { glueColumns, finalPartitionKeys } = await resolveTableShape(destConfig, identity, dataset);

  try {
    await glue.send(
      new CreateTableCommand({
        DatabaseName: databaseName,
        TableInput: {
          Name: tableName,
          PartitionKeys: finalPartitionKeys.map((p) => ({ Name: p.name, Type: p.type })),
          StorageDescriptor: {
            ...PARQUET_STORAGE_DESCRIPTOR_BASE,
            Columns: glueColumns,
            Location: `s3://${destConfig.bucketName}/${rootKey}`,
          },
          Parameters: {
            classification: 'parquet',
            // Enable Partition Projection to calculate partition locations in-memory
            'projection.enabled': 'true',
            'projection.year.type': 'integer',
            'projection.year.range': '2000,2100',
            'projection.month.type': 'integer',
            'projection.month.range': '1,12',
            'projection.month.digits': '2',
            'storage.location.template': `s3://${destConfig.bucketName}/${rootKey}year=\${year}/month=\${month}`,
          },
          TableType: 'EXTERNAL_TABLE',
        },
      })
    );
  } catch (err: any) {
    if (err.name === 'AlreadyExistsException') {
      logger.info(
        `[glue] ${label} table created concurrently | db:${databaseName} table:${tableName}`
      );
      return false;
    }
    logger.error(
      `[glue] ensure ${label} table failed | db:${databaseName} table:${tableName} err:${err.name}: ${err.message}`
    );
    throw err;
  }

  logger.info(
    `[glue] created ${label} table | db:${databaseName} table:${tableName} columns:${glueColumns.length} partitions:${finalPartitionKeys.length}`
  );
  await syncPartitions();
  return true;
};

export const ensureHudiCurrentStateTable = async (
  params: IEnsureCompressionTableParams
): Promise<boolean> =>
  ensureHudiFormatTable({
    ...params,
    tableName: buildHudiTableName(params.backupConfigId, params.objectName),
    dataset: 'main_backup_files',
  });

export const ensureDeltaTable = async (params: IEnsureCompressionTableParams): Promise<boolean> =>
  ensureHudiFormatTable({
    ...params,
    tableName: buildDeltaTableName(params.backupConfigId, params.objectName),
    dataset: 'delta',
  });