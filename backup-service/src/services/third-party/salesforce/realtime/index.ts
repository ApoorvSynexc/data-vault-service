import { IDestinationConfig, IRealtimePayload, ISchemaField } from '../../../../models';
import { logger } from '../../../../middlewares/logger';
import { uploadToS3 } from '../../../destination/s3';
import { readLatestSchema } from '../../../schema';
import { ICrmRealtimeHandler } from '../../types';
import { persistRealtimeSchema } from './schema';

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
// scheduled backup. This stays the authoritative schema for realtime CSVs: it is
// org-wide, whereas the descriptor on the webhook is scoped to whoever triggered
// the DML, so preferring the payload here would make a restricted user's save
// silently drop columns from the CSV. Returns null when no stored schema exists yet
// (e.g. a webhook arriving before the first backup finished), letting the caller
// fall back so a hit is never dropped.
// ---------------------------------------------------------------------------
const loadStoredSchema = async (
  crmId: string,
  crmName: string,
  backupConfigId: string,
  objectApiName: string,
  destConfig: IDestinationConfig
): Promise<ISchemaField[] | null> => {
  try {
    // schema/main/{object}/fields/, falling back to the legacy folder for configs whose last
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

    // Column source, in order of authority:
    //   1. the schema stored in S3 (org-wide, written by the scheduled backup)
    //   2. the descriptor on this hit (permission-scoped, but every field of the
    //      object — still far better than 3, which varies hit to hit)
    //   3. the record's own keys, so an early hit is never dropped for lack of columns
    const storedSchema = await loadStoredSchema(
      crmId,
      crmName,
      backupConfigId,
      objectApiName,
      destConfig
    );
    const columns = storedSchema?.length
      ? storedSchema.map((f) => f.apiName)
      : payload.fields?.length
        ? payload.fields.map((f) => f.apiName)
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

    // Persist the descriptor that came with this hit — fields, picklist values,
    // record types and children — into the same layout the scheduled backup uses.
    // Runs after the records: if anything dies mid-hit, the data is the part worth
    // having. Writes changes/<realtimeJobId>/ only — main/ is never written from a
    // permission-scoped webhook descriptor. See persistRealtimeSchema.
    await persistRealtimeSchema({
      payload,
      destConfig,
      crmId,
      crmName,
      backupConfigId,
      backupJobId: realtimeJobId,
    });

    // schemaChanged is always false now — realtime no longer detects schema drift.
    return { s3Path, schemaChanged: false, sizeInBytes };
  },
};
