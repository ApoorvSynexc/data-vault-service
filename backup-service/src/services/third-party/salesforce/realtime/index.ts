import { IDestinationConfig, IRealtimePayload, ISchemaField } from '../../../../models';
import { logger } from '../../../../middlewares/logger';
import { uploadToS3 } from '../../../destination/s3';
import { readLatestSchema } from '../../../schema';
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
  try {
    // schema/main/fields/, falling back to the legacy folder for configs whose last
    // scheduled backup predates the main/changes layout.
    return (await readLatestSchema(destConfig, {
      crmId,
      crmName,
      backupConfigId,
      objectName: objectApiName,
      type: 'backup',
    })) as ISchemaField[] | null;
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

    // Ensure the Glue table exists, THEN register this job's partition. The order
    // matters: BatchCreatePartition against a table that does not exist yet fails
    // with EntityNotFoundException and is never retried, so a webhook arriving
    // before the first scheduled backup would leave its CSVs invisible to Athena.
    //
    // Table creation is idempotent (the initial/scheduled backup normally made it
    // already). No schema comparison in realtime: schema evolution is owned by the
    // scheduled backup that rewrites fields.json, so realtime just mirrors whatever
    // schema is already stored.
    const glueReady = columns.length
      ? createCsvGlueTable({
          crmId,
          crmName,
          backupConfigId,
          objectName: objectApiName,
          type: 'backup',
          destConfig,
          columns: columns.map((name) => ({ name, type: 'string' })),
        })
      : Promise.resolve();

    glueReady
      .then(() =>
        registerBackupJobPartition({
          crmId,
          crmName,
          backupConfigId,
          objectName: objectApiName,
          backupJobId: realtimeJobId,
          type: 'backup',
          destConfig,
        })
      )
      .catch((err) =>
        logger.error(
          `[glue] failed to ensure table/partition | realtimeJobId:${realtimeJobId} objectApiName:${objectApiName} err:${err?.message ?? err}`
        )
      );

    // schemaChanged is always false now — realtime no longer detects schema drift.
    return { s3Path, schemaChanged: false, sizeInBytes };
  },
};
