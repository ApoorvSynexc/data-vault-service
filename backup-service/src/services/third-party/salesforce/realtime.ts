import { IDestinationConfig, IRealtimePayload } from '../../../models';
import { logger } from '../../../middlewares/logger';
import { httpRequest } from '../../../utils/http-request';
import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';
import { buildSchemaS3Key, toParquetDataType, schemasAreEqual } from '../../../utils/helper';
import { downloadFromS3, uploadToS3 } from '../../destination/s3';
import { ICrmRealtimeHandler } from '../types';

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
// Convert a records array to a CSV Buffer.
// Drops the Salesforce `attributes` meta field.
// Cells with commas, quotes, or newlines are double-quoted and escaped.
// ---------------------------------------------------------------------------
const recordsToCsv = (records: Record<string, any>[]): Buffer => {
  if (!records.length) {
    return Buffer.alloc(0);
  }

  const headers = Object.keys(records[0]).filter((k) => k !== 'attributes');

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
    headers.join(','),
    ...records.map((r) => headers.map((h) => escapeCell(r[h])).join(',')),
  ];

  return Buffer.from(lines.join('\n'), 'utf8');
};

// ---------------------------------------------------------------------------
// Derive a schema descriptor from the record field names.
// Realtime payloads carry no Salesforce type metadata, so every field is
// treated as STRING/BYTE_ARRAY — consistent with the bulk-job schema helper.
// ---------------------------------------------------------------------------
const deriveSchema = (
  records: Record<string, any>[]
): { name: string; dataType: string; parquetDataType: string }[] => {
  if (!records.length) {
    return [];
  }
  return Object.keys(records[0])
    .filter((k) => k !== 'attributes')
    .map((name) => ({ name, dataType: 'STRING', parquetDataType: toParquetDataType('STRING') }));
};

// ---------------------------------------------------------------------------
// Salesforce realtime handler — implements ICrmRealtimeHandler
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

    // ── Upload CSV ──────────────────────────────────────────────────────────
    const folder = operationToFolder(operation);
    const s3Key = `${crmName}/${crmId}/backup/${backupConfigId}/raw_data/${objectApiName}/${folder}/${realtimeJobId}.csv`;
    const csvBuffer = recordsToCsv(records);
    const sizeInBytes = csvBuffer.length;
    const s3Path = await uploadToS3(destConfig, s3Key, csvBuffer);

    logger.info(
      `Realtime job ${realtimeJobId}: uploaded ${records.length} ${operation} record(s) for ${objectApiName} → ${s3Path}`
    );

    // ── Schema comparison ───────────────────────────────────────────────────
    const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectApiName);
    const latestSchema = deriveSchema(records);

    const existingBuffer = await downloadFromS3(destConfig, schemaKey);
    const schemaChanged =
      !existingBuffer ||
      !schemasAreEqual(JSON.parse(existingBuffer.toString()), latestSchema);

    if (schemaChanged) {
      await uploadToS3(destConfig, schemaKey, Buffer.from(JSON.stringify(latestSchema, null, 2)));

      await httpRequest({
        url: `${CORE_SERVICE}/v1/internal/backup-payload`,
        method: 'POST',
        body: JSON.stringify({
          eventType: 'schema.updated',
          crmId,
          objectName: objectApiName,
          backupJobId: realtimeJobId,
          backupConfigId,
          schemaChange: true,
        }),
        headers: {
          'x-internal-secret': INTERNAL_SECRET,
        },
      });

      logger.info(
        `Realtime job ${realtimeJobId}: schema changed for ${objectApiName}, core service notified`
      );
    }

    logger.info(`Realtime job ${realtimeJobId} completed with schemaChanged=${schemaChanged}`);
    return { s3Path, schemaChanged, sizeInBytes };
  },
};
