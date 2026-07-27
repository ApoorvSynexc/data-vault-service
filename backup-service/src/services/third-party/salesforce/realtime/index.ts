import { IDestinationConfig, IRealtimePayload, ISchemaField } from '../../../../models';
import { logger } from '../../../../middlewares/logger';
import { buildSchemaS3Key } from '../../../../utils/helper';
import { downloadFromS3, uploadToS3, listS3Objects } from '../../../destination/s3';
import { ICrmRealtimeHandler } from '../../types';
import { createCsvGlueTable, registerBackupJobPartition } from '../../glue';

// ---------------------------------------------------------------------------
// Map Salesforce CDC operation to the S3 folder convention used by bulk jobs
// ---------------------------------------------------------------------------
const operationToFolder = (operation: string): 'inserts' | 'updates' | 'deletes' => {
  switch (operation.toUpperCase()) {
    case 'UPDATE':
      return 'updates';
    case 'DELETE':
      return 'deletes';
    case 'INSERT':
    case 'UNDELETE':
    default:
      return 'inserts';
  }
};

// ---------------------------------------------------------------------------
// Convert a records array to a CSV Buffer using an explicit column list.
// Columns come from the stored S3 schema (see loadStoredSchema) so every CSV
// has the same, schema-defined shape regardless of which fields a given CDC
// record carries. Cells with commas, quotes, or newlines are double-quoted and escaped.
// ---------------------------------------------------------------------------
const recordsToCsv = (records: Record<string, any>[], columns: string[]): Buffer => {
  if (!records.length || !columns.length) {
    return Buffer.alloc(0);
  }

  const escapeCell = (val: unknown): string => {
    if (val === null || val === undefined) {
      return '';
    }
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const lines = [
    columns.join(','),
    ...records.map((r) => columns.map((h) => escapeCell(r[h])).join(',')),
  ];

  return Buffer.from(lines.join('\n'), 'utf8');
};

// ---------------------------------------------------------------------------
// Load the schema already stored in S3 for this object — written by the initial /
// scheduled backup. This is the authoritative schema for realtime CSVs; the schema
// Salesforce ships on each webhook hit is ignored. Returns null when no stored schema
// exists yet (e.g. a webhook arriving before the first backup finished), letting the
// caller fall back to the record's own keys so a hit is never dropped.
// ---------------------------------------------------------------------------
const loadStoredSchema = async (
  crmId: string,
  crmName: string,
  backupConfigId: string,
  objectApiName: string,
  destConfig: IDestinationConfig
): Promise<ISchemaField[] | null> => {
  // Prefer the latest versioned file (fields_<timestamp>.json with the highest
  // timestamp); fall back to the original fields.json when none exist yet.
  const schemaKey = buildSchemaS3Key({
    crmId,
    crmName,
    backupConfigId,
    objectName: objectApiName,
    type: 'backup',
  });
  const schemaFolder = schemaKey.replace('/fields.json', '/');
  const allSchemaKeys = await listS3Objects(destConfig, schemaFolder);
  const versionedKeys = allSchemaKeys.filter((k) => /fields_\d+\.json$/.test(k));
  // Keys are sorted alphabetically; since timestamps are fixed-width numbers the
  // last entry is also the most recent.
  const currentSchemaKey =
    versionedKeys.length > 0 ? versionedKeys[versionedKeys.length - 1] : schemaKey;

  try {
    const buffer = await downloadFromS3(destConfig, currentSchemaKey);
    if (!buffer) {
      return null;
    }
    return JSON.parse(buffer.toString()) as ISchemaField[];
  } catch {
    logger.debug(`No stored schema found for ${objectApiName}, falling back to record keys`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Salesforce realtime handler — implements ICrmRealtimeHandler
// Performs real-time schema comparison using payload schema
// ---------------------------------------------------------------------------
export const salesforceRealtimeHandler: ICrmRealtimeHandler = {
  async processPayload(
    realtimeJobId,
    backupConfigId,
    crmId,
    crmName,
    destConfig: IDestinationConfig,
    payload: IRealtimePayload
  ) {
    const { records, operation, objectApiName } = payload;

    // Columns come from the schema already stored in S3 — never from the schema
    // Salesforce ships on the webhook. Fall back to the record's own keys only when
    // no stored schema exists yet, so an early hit is never dropped for lack of columns.
    const storedSchema = await loadStoredSchema(
      crmId,
      crmName,
      backupConfigId,
      objectApiName,
      destConfig
    );
    const columns = storedSchema?.length
      ? storedSchema.map((f) => f.apiName)
      : Object.keys(records[0] ?? {}).filter((k) => k !== 'attributes');

    // ── Upload CSV ──────────────────────────────────────────────────────────
    // All hits for the same job share the same backupJobId folder.
    // Each hit gets a unique UUID filename so concurrent uploads never overwrite each other.
    const folder = operationToFolder(operation);
    const s3Key = `${crmName}/${crmId}/backup/${backupConfigId}/raw_data/${realtimeJobId}/${objectApiName}/${folder}/${Date.now()}.csv`;
    const csvBuffer = recordsToCsv(records, columns);
    const sizeInBytes = csvBuffer.length;
    const s3Path = await uploadToS3(destConfig, s3Key, csvBuffer);

    logger.info(
      `Realtime job ${realtimeJobId}: uploaded ${records.length} ${operation} record(s) for ${objectApiName} → ${s3Path}`
    );

    // Register the Glue partition for this job's first CSV upload — idempotent.
    registerBackupJobPartition({
      crmId,
      crmName,
      backupConfigId,
      objectName: objectApiName,
      backupJobId: realtimeJobId,
      type: 'backup',
      destConfig,
    }).catch((err) =>
      logger.error(
        `[glue] failed to register partition | realtimeJobId:${realtimeJobId} objectApiName:${objectApiName} err:${err?.message ?? err}`
      )
    );

    // Ensure the Glue table exists using the stored schema (idempotent — the
    // initial/scheduled backup normally created it already). No schema comparison
    // in realtime: schema evolution is owned by the scheduled backup that rewrites
    // fields.json, so realtime just mirrors whatever schema is already stored.
    if (columns.length) {
      createCsvGlueTable({
        crmId,
        crmName,
        backupConfigId,
        objectName: objectApiName,
        type: 'backup',
        destConfig,
        columns: columns.map((name) => ({ name, type: 'string' })),
      }).catch((err) =>
        logger.error(
          `[glue] failed to create table | realtimeJobId:${realtimeJobId} objectApiName:${objectApiName} err:${err?.message ?? err}`
        )
      );
    }

    // schemaChanged is always false now — realtime no longer detects schema drift.
    return { s3Path, schemaChanged: false, sizeInBytes };
  },
};
