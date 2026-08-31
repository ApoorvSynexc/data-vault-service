import { IDestinationConfig, IRealtimePayload, ISchemaField } from '../../../../models';
import { logger } from '../../../../middlewares/logger';
import { uploadToS3 } from '../../../destination/s3';
import { readLatestSchema } from '../../../schema';
import { ICrmRealtimeHandler } from '../../types';
import { persistRealtimeSchema } from './schema';
import { EXCLUDED_FIELD_NAMES, EXCLUDED_FIELD_TYPES, ISalesforceFieldSnapshot } from '../metadata/field';

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
// const recordsToCsv = (records: Record<string, any>[], columns: string[]): Buffer => {
//   if (!records.length || !columns.length) {
//     return Buffer.alloc(0);
//   }

//   const escapeCell = (val: unknown): string => {
//     if (val === null || val === undefined) {
//       return '';
//     }
//     const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
//     return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
//       ? `"${s.replace(/"/g, '""')}"`
//       : s;
//   };

//   const lines = [
//     columns.join(','),
//     ...records.map((r) => columns.map((h) => escapeCell(r[h])).join(',')),
//   ];

//   return Buffer.from(lines.join('\n'), 'utf8');
// };

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
): Promise<ISalesforceFieldSnapshot[] | null> => {
  try {
    // schema/main/{object}/fields/, falling back to the legacy folder — the same
    // isQueryableField-filtered snapshot the scheduled backup writes and builds its
    // Bulk API SELECT list from (see metadata/field/index.ts:schemaHandler).
    return (await readLatestSchema(destConfig, {
      crmId,
      crmName,
      backupConfigId,
      objectName: objectApiName,
      type: 'backup',
    })) as ISalesforceFieldSnapshot[] | null;
  } catch {
    logger.debug(`No stored schema found for ${objectApiName}, falling back to record keys`);
    return null;
  }
};

// Same gate the scheduled backup uses to keep the Bulk API SELECT list and the
// schema folder in sync (metadata/field/index.ts:isQueryableField) — applied here
// to the permission-scoped descriptor fallback so a realtime hit never persists a
// compound Address/Location/Base64 field the Bulk query could never have selected.
const isQueryableSchemaField = (f: ISchemaField): boolean =>
  !EXCLUDED_FIELD_NAMES.has(f.apiName) && !EXCLUDED_FIELD_TYPES.has((f.dataType ?? '').toLowerCase());

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
    let { records } = payload;
    const { operation, objectApiName } = payload;

    if (records.length) {
      records = records.map((record) => {
        if (record.records) {
          return record.records;
        }
        return record;
      });
    }

    // Column source, in order of authority:
    //   1. the schema stored in S3 (org-wide, written by the scheduled backup) — the
    //      same isQueryableField-filtered list the Bulk API SELECT is built from
    //   2. the descriptor on this hit (permission-scoped), filtered the same way
    //   3. the record's own keys, so an early hit is never dropped for lack of columns
    const storedSchema = await loadStoredSchema(
      crmId,
      crmName,
      backupConfigId,
      objectApiName,
      destConfig
    );
    const columns = storedSchema?.length
      ? storedSchema.map((f) => f.name)
      : payload.fields?.length
        ? payload.fields.filter(isQueryableSchemaField).map((f) => f.apiName)
        : null;

    // Drop any key not in the Bulk-query field set (e.g. compound Address/Location
    // fields) so realtime writes never store more than a scheduled backup would.
    // Per-record fallback to the record's own keys: if the column list doesn't
    // intersect this particular record (stale/mismatched schema, renamed object),
    // filtering to nothing would silently write `{}` instead of the real data.
    const filteredRecords = columns
      ? records.map((record) => {
          const filtered = Object.fromEntries(
            columns.filter((c) => c in record).map((c) => [c, record[c]])
          );
          return Object.keys(filtered).length ? filtered : record;
        })
      : records;

    // ── Upload ───────────────────────────────────────────────────────────────
    // All hits for the same job share the same backupJobId folder.
    // Each hit gets a unique UUID filename so concurrent uploads never overwrite each other.
    // realtimeJobId (backupJobId) must stay in this key — see the note on
    // buildS3KeyPrefix in utils/helper.ts for why dropping it collides every job for
    // an object into one shared raw_data/<object>/ folder.
    const folder = operationToFolder(operation);
    const s3Key = `${crmName}/${crmId}/backup/${backupConfigId}/raw_data/${realtimeJobId}/${objectApiName}/${folder}/${Date.now()}.json`;
    const csvBuffer = Buffer.from(JSON.stringify(filteredRecords), 'utf8');
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
