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
  NODE_ENV
} from '../../../constant';
import { logger } from '../../../middlewares/logger';
import { IDestinationConfig } from '../../../models';
import { readHudiTableSchema } from './hudi-schema';
import { listS3Prefixes } from '../../destination/s3';

// Platform-owned Glue client — always uses our own AWS credentials,
// never the customer's destination bucket credentials.
const glue = new GlueClient({
  region: AWS_REGION,
  ...(NODE_ENV === 'dev' && AWS_GLUE_ACCESS_KEY && AWS_GLUE_SECRET_KEY
    ? {
        credentials: {
          accessKeyId: AWS_GLUE_ACCESS_KEY,
          secretAccessKey: AWS_GLUE_SECRET_KEY,
        },
      }
    : {}),
});

// Glue identifiers (database/table names) only allow lowercase letters,
// numbers, and underscores. Sanitize any input before using it as an identifier.
const toGlueIdentifier = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

// One Glue database per backupConfigId — every backupJobId belonging to that
// config reuses the same database, so a config's Hudi + Delta tables always
// live together regardless of how many jobs produced them.
//   e.g.  backupConfigId "abc123" → database "abc123"
const buildGlueDatabaseName = (backupConfigId: string): string => toGlueIdentifier(backupConfigId);

// Table name encodes backupConfigId + objectApiName for uniqueness within the
// database.
//   e.g.  cfg_abc123_account
const buildGlueTableName = (backupConfigId: string, objectName: string): string =>
  `cfg_${toGlueIdentifier(backupConfigId)}_${toGlueIdentifier(objectName)}`;

// In-flight CreateDatabaseCommand calls, keyed by databaseName. ensureHudiFormatTable
// calls ensureGlueDatabase once per object per format (hudi + delta), so a single
// ensure-compression-tables run already fans out into 2×objectNames.length concurrent
// callers for the SAME not-yet-existing database. AWS Glue does not reliably turn the
// losers of that race into a clean AlreadyExistsException — it can surface
// ConcurrentModificationException instead, which is a real (rethrown) error here, not
// idempotency. Memoizing the in-flight promise per databaseName collapses that fan-out
// into exactly one CreateDatabaseCommand call; every other caller just awaits it.
const inFlightDatabaseCreate = new Map<string, Promise<void>>();

// Ensures the Glue database exists. Creates it if not — idempotent, and safe under
// any amount of same-process concurrency for the same databaseName (see map above).
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

export interface IGlueColumnDef {
  name: string;
  // Glue type string — e.g. 'string', 'bigint', 'double', 'boolean', 'timestamp'
  type: string;
  comment?: string;
}

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
//   Delta: <crmName>/<crmId>/backup/<cfg>/deltas/<Object>/

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

// Set on BOTH tables — Hudi (main_backup_files) and Delta both use
// HUDI_STORAGE_DESCRIPTOR_BASE's HoodieParquetInputFormat, so both hit
// Athena's known legacy-SerDe limitation: spurious S3 403s reading `.hoodie`
// metadata even with fully correct IAM/bucket policies. The documented fix is
// this Glue table property, which switches Athena to its native Hudi
// connector. Set here, at table creation/sync time (this service already
// holds Glue write access), so the read path never has to ALTER TABLE itself
// or need glue:UpdateTable.
const NATIVE_HUDI_CONNECTOR_PARAM = 'athena_enable_native_hudi_connector_implementation';

// Lets Athena use Hudi's file-listing index for partition discovery instead of
// a full S3 listing. Set alongside the native connector param at both create
// and sync time, for the same reason: a table created before this property
// existed must not be stuck without it forever.
const HUDI_METADATA_LISTING_PARAM = 'hudi.metadata-listing-enabled';

const buildHudiTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_hudi`;

const buildDeltaTableName = (backupConfigId: string, objectName: string): string =>
  `${buildGlueTableName(backupConfigId, objectName)}_delta`;

// S3 folder Spark actually writes each dataset to — the delta folder is plural
// ("deltas") even though the `dataset` discriminator used elsewhere (labels, table
// naming) stays singular ("delta").
const DATASET_S3_FOLDER: Record<'main_backup_files' | 'delta', string> = {
  main_backup_files: 'main_backup_files',
  delta: 'deltas',
};

// S3 key prefix (no bucket) of a compression-output table root.
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
}

// Registers the year=YYYY/month=MM partitions that exist on S3 for a
// Hudi-format table. Athena silently returns ZERO rows for a partitioned table
// with no registered partitions — `hudi.metadata-listing-enabled` only covers
// engine v3 with the Hudi metadata table intact, so explicit registration is
// the deterministic path. Two delimiter listings (years, then months) — never
// a full object enumeration. Idempotent: already-registered partitions come
// back as AlreadyExistsException entries in the batch response and are ignored.
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
        // No Columns on the partition SD — Athena falls back to the table's columns.
        StorageDescriptor: {
          ...HUDI_STORAGE_DESCRIPTOR_BASE,
          Location: `s3://${destConfig.bucketName}/${monthPrefix}`,
        },
      });
    }
  }

  if (partitionInputs.length === 0) {
    logger.info(`[glue] no hive-style partitions found on S3 | table:${tableName} root:${rootKey}`);
    return;
  }

  // BatchCreatePartition caps at 100 inputs per call.
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

// Resolves the Glue column + partition shape for a dataset from what Spark
// actually committed on S3. Both tables are partitioned by year/month (Hive-style
// folders) and carry backup_job_id as a data column: guarantee all three
// regardless of what the reader found, and keep the invariant that a name is
// never both a partition key and a data column (Hive/Athena reject that).
const resolveHudiTableShape = async (
  destConfig: IDestinationConfig,
  rootKey: string
): Promise<{ glueColumns: Column[]; finalPartitionKeys: { name: string; type: string }[] }> => {
  // Authoritative: matches exactly what Spark committed. Throws if not written yet.
  const { columns, partitionKeys } = await readHudiTableSchema(destConfig, rootKey);

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

  return { glueColumns, finalPartitionKeys };
};

// Refreshes the columns of an already-existing table to match what Spark last
// committed. Necessary because the datasets evolve — the delta schema gained
// delta_id / is_schema_change / schema_change_type after the first tables were
// cut — and Athena fails the whole query on a column the catalog does not carry.
//
// Only writes when the shape actually differs: Glue keeps a version per
// UpdateTable and this runs on every compression completion. Partition keys are
// left exactly as they are — Glue refuses to change them on a partitioned table.
const syncHudiTableSchema = async (
  databaseName: string,
  tableName: string,
  destConfig: IDestinationConfig,
  rootKey: string
): Promise<void> => {
  const { glueColumns } = await resolveHudiTableShape(destConfig, rootKey);
  const { Table } = await glue.send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );

  const signature = (cols: Column[] = []): string =>
    cols.map((c) => `${c.Name}:${c.Type}`).join(',');
  const columnsMatch = signature(Table?.StorageDescriptor?.Columns) === signature(glueColumns);
  // Both Hudi + Delta tables want these two properties — a pre-existing table
  // created before either was added won't carry them yet, so a plain
  // column-signature check would keep skipping them forever.
  const hasNativeConnector = Table?.Parameters?.[NATIVE_HUDI_CONNECTOR_PARAM] === 'true';
  const hasMetadataListing = Table?.Parameters?.[HUDI_METADATA_LISTING_PARAM] === 'TRUE';
  if (columnsMatch && hasNativeConnector && hasMetadataListing) {
    return;
  }

  await glue.send(
    new UpdateTableCommand({
      DatabaseName: databaseName,
      TableInput: {
        Name: tableName,
        PartitionKeys: Table?.PartitionKeys ?? [],
        StorageDescriptor: {
          ...HUDI_STORAGE_DESCRIPTOR_BASE,
          Columns: glueColumns,
          Location: Table?.StorageDescriptor?.Location ?? '',
        },
        Parameters: {
          ...(Table?.Parameters ?? {}),
          [NATIVE_HUDI_CONNECTOR_PARAM]: 'true',
          [HUDI_METADATA_LISTING_PARAM]: 'TRUE',
        },
        TableType: Table?.TableType ?? 'EXTERNAL_TABLE',
      },
    })
  );

  logger.info(
    `[glue] refreshed table schema | table:${tableName} columns:${glueColumns.length}` +
      ` (was ${Table?.StorageDescriptor?.Columns?.length ?? 0})`
  );
};

// Creates one Hudi-format Glue table, idempotently. Reads the committed schema
// from `.hoodie` on the client bucket, then creates the table pointing at the
// dataset root. Returns false (no-op) when the table already exists.
// In BOTH cases it then syncs the year/month partitions from S3 — new
// partitions appear as compression runs land, and Athena needs them registered —
// and, on the existing-table path, refreshes the columns so a schema that has
// evolved since creation reaches the catalog.
const ensureHudiFormatTable = async (
  params: IEnsureCompressionTableParams & {
    tableName: string;
    dataset: 'main_backup_files' | 'delta';
  }
): Promise<boolean> => {
  const { crmId, crmName, backupConfigId, objectName, destConfig, tableName, dataset } = params;

  const databaseName = buildGlueDatabaseName(backupConfigId);
  const label = dataset === 'main_backup_files' ? 'hudi' : dataset;

  logger.info(`[glue] ensure ${label} table start | db:${databaseName} table:${tableName}`);

  await ensureGlueDatabase(databaseName);

  const rootKey = buildCompressionRootKey(crmName, crmId, backupConfigId, objectName, dataset);

  // Partition sync is best-effort in both branches: a failure must not undo the
  // COMPRESSED status handoff this call rides on.
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
    // Best-effort, same reason as the partition sync below.
    await syncHudiTableSchema(databaseName, tableName, destConfig, rootKey).catch((err: any) => {
      logger.warn(`[glue] schema sync failed | table:${tableName} err:${err.name}: ${err.message}`);
    });
    await syncPartitions();
    return false;
  }

  const { glueColumns, finalPartitionKeys } = await resolveHudiTableShape(destConfig, rootKey);

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
            [HUDI_METADATA_LISTING_PARAM]: 'TRUE',
            [NATIVE_HUDI_CONNECTOR_PARAM]: 'true',
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
