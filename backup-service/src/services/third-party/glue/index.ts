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
import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { SCHEMA_KIND_FILE } from '../../../utils/helper';
import { listS3Prefixes } from '../../destination/s3';
import { getStoredEntries } from '../salesforce/metadata/common';

// One GlueClient per region, not one global client: the Glue Data Catalog is
// regional, and every call here must run in the same region as the CLIENT's
// own destination S3 bucket the table's data lives in — never the platform's
// own default region, which may not even match where that bucket actually
// is. Keyless: no static access/secret key, ever — resolves through the
// SDK's default credential provider chain (IAM role of the running
// environment).
const glueClients = new Map<string, GlueClient>();
const getGlueClient = (region: string): GlueClient => {
  let client = glueClients.get(region);
  if (!client) {
    client = new GlueClient({ region });
    glueClients.set(region, client);
  }
  return client;
};

const toGlueIdentifier = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
const buildGlueDatabaseName = (backupConfigId: string): string => toGlueIdentifier(backupConfigId);
const buildGlueTableName = (backupConfigId: string, objectName: string): string =>
  `cfg_${toGlueIdentifier(backupConfigId)}_${toGlueIdentifier(objectName)}`;

const inFlightDatabaseCreate = new Map<string, Promise<void>>();

const ensureGlueDatabase = async (databaseName: string, region: string): Promise<void> => {
  const existing = inFlightDatabaseCreate.get(databaseName);
  if (existing) {
    logger.info(
      `[glue] ensureGlueDatabase duplicate | db:${databaseName} awaiting in-progress create`
    );
    return existing;
  }

  logger.info(`[glue] ensureGlueDatabase start | db:${databaseName}`);
  const create = (async () => {
    try {
      await getGlueClient(region).send(
        new CreateDatabaseCommand({ DatabaseInput: { Name: databaseName } })
      );
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
  })();
  inFlightDatabaseCreate.set(databaseName, create);

  try {
    await create;
    logger.info(`[glue] ensureGlueDatabase complete | db:${databaseName}`);
  } finally {
    inFlightDatabaseCreate.delete(databaseName);
  }
};

const glueTableExists = async (
  databaseName: string,
  tableName: string,
  region: string
): Promise<boolean> => {
  try {
    await getGlueClient(region).send(
      new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
    );
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

// An archival config's data lives under the `archival/` S3 prefix: the
// schema-only delta Hudi table (PathUtils.archivalDeltaHudi) and the
// current-state table, which is written to `main_archival_files/` rather than
// `main_backup_files/`. Both are scoped by the same backupConfigId Node passes
// as the Spark job's "jobId". A backup config keeps the `backup/` prefix and
// the original folder names.
const buildCompressionRootKey = (
  crmName: string,
  crmId: string,
  backupConfigId: string,
  objectName: string,
  dataset: 'main_backup_files' | 'delta',
  policyConfigType: 'backup' | 'archival' = 'backup'
): string => {
  const isArchival = policyConfigType === 'archival';
  const root = isArchival ? 'archival' : 'backup';
  const folder =
    dataset === 'main_backup_files' && isArchival ? 'main_archival_files' : DATASET_S3_FOLDER[dataset];
  return `${crmName}/${crmId}/${root}/${backupConfigId}/${folder}/${objectName}/`;
};

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
    const result = await getGlueClient(destConfig.region).send(
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
  const glue = getGlueClient(destConfig.region);
  const { Table } = await glue.send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );

  const signature = (cols: Column[] = []): string =>
    cols.map((c) => `${c.Name}:${c.Type}`).join(',');
  const columnsMatch = signature(Table?.StorageDescriptor?.Columns) === signature(glueColumns);
  const hasProjection = Table?.Parameters?.['projection.enabled'] === 'true';
  // Heals tables created before the archival root moved to `archival/…`: their
  // stored Location still points at the empty `backup/…` folder.
  const expectedLocation = `s3://${destConfig.bucketName}/${rootKey}`;
  const locationMatches = Table?.StorageDescriptor?.Location === expectedLocation;

  if (columnsMatch && hasProjection && locationMatches) {
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
          Location: expectedLocation,
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
  const {
    crmId,
    crmName,
    policyConfigType,
    backupConfigId,
    objectName,
    destConfig,
    tableName,
    dataset,
  } = params;
  const identity: ITableIdentity = { crmId, crmName, policyConfigType, backupConfigId, objectName };

  const databaseName = buildGlueDatabaseName(backupConfigId);
  const label = dataset === 'main_backup_files' ? 'hudi' : dataset;

  logger.info(`[glue] ensure ${label} table start | db:${databaseName} table:${tableName}`);

  await ensureGlueDatabase(databaseName, destConfig.region);

  const rootKey = buildCompressionRootKey(crmName, crmId, backupConfigId, objectName, dataset, policyConfigType);

  const syncPartitions = (): Promise<void> =>
    syncHudiTablePartitions(databaseName, tableName, destConfig, rootKey).catch((err: any) => {
      logger.warn(
        `[glue] partition sync failed | table:${tableName} err:${err.name}: ${err.message}`
      );
    });

  if (await glueTableExists(databaseName, tableName, destConfig.region)) {
    logger.info(
      `[glue] ${label} table already exists, syncing schema + partitions | db:${databaseName} table:${tableName}`
    );
    await syncHudiTableSchema(
      databaseName,
      tableName,
      destConfig,
      rootKey,
      identity,
      dataset
    ).catch((err: any) => {
      logger.warn(`[glue] schema sync failed | table:${tableName} err:${err.name}: ${err.message}`);
    });
    await syncPartitions();
    return false;
  }

  const { glueColumns, finalPartitionKeys } = await resolveTableShape(
    destConfig,
    identity,
    dataset
  );

  try {
    await getGlueClient(destConfig.region).send(
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

// ---------------------------------------------------------------------------
// Raw-data tables — read directly over raw_data (CSV/JSON), for the pending
// tail not yet folded into the Hudi/Delta compression output by Spark.
//
// A BACKUP config's "changed" listing (buildRawCsvChangedSql, client-service)
// is deliberately UPDATES AND DELETES ONLY — never inserts. An "inserts"
// folder can hold an object's entire first-time full sync (potentially
// millions of rows for a brand-new backup or a realtime object's initial
// Bulk-API load), which is the opposite of the small, bounded tail that query
// assumes; a newly created record simply isn't visible there until the next
// Spark compression run picks it up. Updates/deletes to an already-known
// record are always small, incremental, and the more urgent staleness to
// close.
//
// `inserts` IS still part of the raw_csv Glue table's operation partition
// (see CSV_OPERATIONS below) for two other, narrower reads that don't share
// that "could be millions of rows" problem: a targeted point-lookup by Id
// (base-row reconstruction for a realtime diff with no other base), and an
// ARCHIVAL config's own ENTIRE listing — archival-v2 only ever writes
// full-snapshot `inserts/` (confirmed, never updates/deletes), and an
// archival run is a bounded, policy-scoped batch, not an open-ended full
// sync, so listing it wholesale is the intended behavior there, not the
// "millions of rows" case this rule guards against for BACKUP.
//
// backupJobId is an `injected` partition-projection column: no partition is
// ever registered or deleted in Glue for it (no BatchCreatePartitionCommand,
// ever). A query just names the ids it wants in its WHERE clause and Athena
// substitutes them into storage.location.template at query time — so a new
// job's data is queryable the instant client-service names its id, and
// nothing needs cleaning up once that job is compressed: the caller simply
// stops asking for it (see client-service's pending-jobs lookup).
// ---------------------------------------------------------------------------

const CSV_STORAGE_DESCRIPTOR_BASE = {
  InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
  OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
  SerdeInfo: {
    SerializationLibrary: 'org.apache.hadoop.hive.serde2.OpenCSVSerde',
  },
  Compressed: false,
  NumberOfBuckets: -1,
} as const;

const JSON_STORAGE_DESCRIPTOR_BASE = {
  InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
  OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
  SerdeInfo: {
    SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
  },
  Compressed: false,
  NumberOfBuckets: -1,
} as const;

// Fixed schema for every object's JSON update-delta table — a realtime UPDATE
// event's shape ({Id, LastModifiedDate, prev, new}) is the same regardless of
// the Salesforce object, so there is nothing to derive from S3, same as
// DELTA_TABLE_COLUMNS above.
const RAW_JSON_DELTA_COLUMNS: IGlueColumnDef[] = [
  { name: 'id', type: 'string' },
  { name: 'lastmodifieddate', type: 'string' },
  { name: 'prev', type: 'map<string,string>' },
  { name: 'new', type: 'map<string,string>' },
];

const buildRawCsvTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_raw_csv`;

const buildRawJsonSnapshotTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_raw_json_snapshot`;

const buildRawJsonDeltaTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_raw_json_delta`;

// Raw-data root, one directory per backupJobId underneath — mirrors
// utils/helper.ts:buildS3KeyPrefix minus the backupJobId/objectName/operation
// segments, which become the table's location template + partition columns
// instead of being baked into a fixed key.
const buildRawDataRootKey = (
  crmName: string,
  crmId: string,
  policyConfigType: 'backup' | 'archival',
  backupConfigId: string
): string => `${crmName}/${crmId}/${policyConfigType}/${backupConfigId}/raw_data/`;

interface IEnsureRawTableParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  destConfig: IDestinationConfig;
  policyConfigType: 'backup' | 'archival';
}

// Either a small enum of operation folders (partitioned — the CSV table,
// which still multiplexes updates+deletes under one table) or a single fixed
// operation baked into the location as a literal path segment, no partition
// column at all (the JSON tables, each dedicated to exactly one operation).
type RawTableOperations = { kind: 'enum'; values: string[] } | { kind: 'fixed'; value: string };

// Shared create-if-absent + schema-drift-sync body for all raw table shapes.
// No partition sync step exists here (unlike ensureHudiFormatTable) —
// injected/enum projection needs no BatchCreatePartitionCommand for either
// backupjobid or operation, ever, so there is nothing to keep in sync besides
// the column list (which can drift the same way Hudi's does, via
// resolveMainTableColumns tracking the client's live field schema).
const ensureRawFormatTable = async (params: {
  tableName: string;
  storageBase: typeof CSV_STORAGE_DESCRIPTOR_BASE | typeof JSON_STORAGE_DESCRIPTOR_BASE;
  classification: 'csv' | 'json';
  columns: IGlueColumnDef[];
  operations: RawTableOperations;
  identity: IEnsureRawTableParams;
}): Promise<boolean> => {
  const { tableName, storageBase, classification, columns, operations, identity } = params;
  const { crmId, crmName, backupConfigId, objectName, destConfig, policyConfigType } = identity;
  const databaseName = buildGlueDatabaseName(backupConfigId);

  logger.info(
    `[glue] ensure raw ${classification} table start | db:${databaseName} table:${tableName}`
  );
  await ensureGlueDatabase(databaseName, destConfig.region);
  const glue = getGlueClient(destConfig.region);

  const rootKey = buildRawDataRootKey(crmName, crmId, policyConfigType, backupConfigId);
  const location = `s3://${destConfig.bucketName}/${rootKey}`;
  const locationTemplate =
    operations.kind === 'enum'
      ? `${location}\${backupjobid}/${objectName}/\${operation}/`
      : `${location}\${backupjobid}/${objectName}/${operations.value}/`;

  const partitionKeys =
    operations.kind === 'enum'
      ? [
          { name: 'backupjobid', type: 'string' },
          { name: 'operation', type: 'string' },
        ]
      : [{ name: 'backupjobid', type: 'string' }];

  const glueColumns: Column[] = columns.map(({ name, type, comment }) => ({
    Name: name,
    Type: type,
    ...(comment ? { Comment: comment } : {}),
  }));

  const projectionParams: Record<string, string> = {
    classification,
    'projection.enabled': 'true',
    'projection.backupjobid.type': 'injected',
    'storage.location.template': locationTemplate,
    ...(classification === 'csv' ? { 'skip.header.line.count': '1' } : {}),
    ...(operations.kind === 'enum'
      ? {
          'projection.operation.type': 'enum',
          'projection.operation.values': operations.values.join(','),
        }
      : {}),
  };

  const tableInputBase = {
    Name: tableName,
    PartitionKeys: partitionKeys.map((p) => ({ Name: p.name, Type: p.type })),
    StorageDescriptor: { ...storageBase, Columns: glueColumns, Location: location },
    Parameters: projectionParams,
    TableType: 'EXTERNAL_TABLE',
  };

  if (await glueTableExists(databaseName, tableName, destConfig.region)) {
    const { Table } = await glue.send(
      new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
    );
    const signature = (cols: Column[] = []): string =>
      cols.map((c) => `${c.Name}:${c.Type}`).join(',');
    if (
      signature(Table?.StorageDescriptor?.Columns) === signature(glueColumns) &&
      Table?.Parameters?.['projection.enabled'] === 'true' &&
      // Column signature alone misses a partition-projection value change
      // (e.g. widening the operation enum) — that lives in table Parameters,
      // not StorageDescriptor.Columns, so it must be compared explicitly or a
      // code-level enum change would silently never reach an already-created
      // table.
      Table?.Parameters?.['projection.operation.values'] ===
        projectionParams['projection.operation.values']
    ) {
      logger.info(`[glue] raw ${classification} table already up to date | table:${tableName}`);
      return false;
    }
    await glue.send(
      new UpdateTableCommand({ DatabaseName: databaseName, TableInput: tableInputBase })
    );
    logger.info(`[glue] refreshed raw ${classification} table schema | table:${tableName}`);
    return false;
  }

  try {
    await glue.send(
      new CreateTableCommand({ DatabaseName: databaseName, TableInput: tableInputBase })
    );
  } catch (err: any) {
    if (err.name === 'AlreadyExistsException') {
      logger.info(`[glue] raw ${classification} table created concurrently | table:${tableName}`);
      return false;
    }
    logger.error(
      `[glue] ensure raw ${classification} table failed | table:${tableName} err:${err.name}: ${err.message}`
    );
    throw err;
  }

  logger.info(
    `[glue] created raw ${classification} table | table:${tableName} columns:${glueColumns.length}`
  );
  return true;
};

// Full-row CSV table — schedule/bulk BACKUP jobs and ARCHIVAL jobs both use
// this same table (identity.policyConfigType picks which S3 prefix it points
// at; the two never collide since each config type has its own backupConfigId
// and therefore its own Glue database). Partitioned over
// 'updates'/'deletes'/'inserts': a schedule backup's "update" row is already
// a complete row (classified by timestamp, not a diff), same as an insert —
// both are full-field snapshots. 'inserts' covers three readers: a record's
// very first full sync (exportFirstTime writes ENTIRELY here — see
// schedule/backup/index.ts), used as a base-row lookup for reconstructing a
// realtime diff when nothing has been compressed yet; and an ARCHIVAL
// config's ENTIRE listing, which archival-v2 writes ENTIRELY as inserts too
// (see runArchivalJob). A BACKUP config's "changed" listing itself still
// hard-filters to updates/deletes only — see the file header above.
const CSV_OPERATIONS: RawTableOperations = {
  kind: 'enum',
  values: ['updates', 'deletes', 'inserts'],
};

export const ensureRawCsvTable = async (params: IEnsureRawTableParams): Promise<boolean> => {
  const columns = await resolveMainTableColumns(params.destConfig, params);
  return ensureRawFormatTable({
    tableName: buildRawCsvTableName(params.backupConfigId, params.objectName),
    storageBase: CSV_STORAGE_DESCRIPTOR_BASE,
    classification: 'csv',
    columns,
    operations: CSV_OPERATIONS,
    identity: params,
  });
};

// Full-row JSON table — realtime DELETE events only. Fixed schema, no
// operation partition (always "deletes"): realtime INSERT/UNDELETE are
// excluded entirely (see the file header), and UPDATE is a separate sparse
// diff (see ensureRawJsonDeltaTable), so this table only ever holds one kind
// of file.
export const ensureRawJsonSnapshotTable = async (
  params: IEnsureRawTableParams
): Promise<boolean> => {
  const columns = await resolveMainTableColumns(params.destConfig, params);
  return ensureRawFormatTable({
    tableName: buildRawJsonSnapshotTableName(params.backupConfigId, params.objectName),
    storageBase: JSON_STORAGE_DESCRIPTOR_BASE,
    classification: 'json',
    columns,
    operations: { kind: 'fixed', value: 'deletes' },
    identity: params,
  });
};

// {Id, LastModifiedDate, prev, new} sparse field-diff table — realtime UPDATE
// events only. Fixed schema, no operation partition (always "updates").
export const ensureRawJsonDeltaTable = async (params: IEnsureRawTableParams): Promise<boolean> =>
  ensureRawFormatTable({
    tableName: buildRawJsonDeltaTableName(params.backupConfigId, params.objectName),
    storageBase: JSON_STORAGE_DESCRIPTOR_BASE,
    classification: 'json',
    columns: RAW_JSON_DELTA_COLUMNS,
    operations: { kind: 'fixed', value: 'updates' },
    identity: params,
  });
