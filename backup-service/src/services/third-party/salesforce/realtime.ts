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
// Convert schema from payload to include parquetDataType
// ---------------------------------------------------------------------------
const enrichSchemaWithParquetTypes = (
  payloadSchema: { label: string; dataType: string; apiName: string }[]
): { apiName: string; dataType: string; parquetDataType: string }[] => {
  return payloadSchema.map((field) => ({
    ...field,
    parquetDataType: toParquetDataType(field.dataType),
  }));
};

// ---------------------------------------------------------------------------
// Real-time schema comparison: compare payload schema with stored schema
// Returns { schemaChanged, latestSchema }
// ---------------------------------------------------------------------------
const compareSchemaInRealtime = async (
  crmId: string,
  crmName: string,
  backupConfigId: string,
  objectApiName: string,
  destConfig: IDestinationConfig,
  payloadSchema: { label: string; dataType: string; apiName: string }[]
): Promise<{
  schemaChanged: boolean;
  latestSchema: { apiName: string; dataType: string; parquetDataType: string }[];
}> => {
  // Enrich payload schema with parquetDataType
  const latestSchema = enrichSchemaWithParquetTypes(payloadSchema);

  // Get existing schema from S3
  const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectApiName);
  let existingSchemaBuffer: Buffer | null = null;

  try {
    existingSchemaBuffer = await downloadFromS3(destConfig, schemaKey);
  } catch {
    logger.debug(`No existing schema found for ${objectApiName}, treating as new`);
  }

  // Compare schemas - only mark as changed if existing schema differs
  const schemaChanged = existingSchemaBuffer
    ? !schemasAreEqual(JSON.parse(existingSchemaBuffer.toString()), latestSchema)
    : false;

  logger.info(`Real-time schema comparison for ${objectApiName}: changed=${schemaChanged}`);

  return {
    schemaChanged,
    latestSchema,
  };
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

    // ── Upload CSV ──────────────────────────────────────────────────────────
    const folder = operationToFolder(operation);
    const s3Key = `${crmName}/${crmId}/backup/${backupConfigId}/raw_data/${objectApiName}/${folder}/${realtimeJobId}.csv`;
    const csvBuffer = recordsToCsv(records);
    const sizeInBytes = csvBuffer.length;
    const s3Path = await uploadToS3(destConfig, s3Key, csvBuffer);

    logger.info(
      `Realtime job ${realtimeJobId}: uploaded ${records.length} ${operation} record(s) for ${objectApiName} → ${s3Path}`
    );

    // ── Real-time schema comparison using payload schema ────────────────────
    let schemaChanged = false;

    try {
      const schemaComparison = await compareSchemaInRealtime(
        crmId,
        crmName,
        backupConfigId,
        objectApiName,
        destConfig,
        payload.schema
      );

      schemaChanged = schemaComparison.schemaChanged;

      if (schemaChanged) {
        const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectApiName);
        const schemaBuffer = Buffer.from(JSON.stringify(schemaComparison.latestSchema, null, 2));
        await uploadToS3(destConfig, schemaKey, schemaBuffer);

        logger.info(`Realtime job ${realtimeJobId}: schema changed for ${objectApiName}`);

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

        logger.info(`Realtime job ${realtimeJobId}: core service notified of schema changes`);
      }
    } catch (err: any) {
      logger.error(
        `Realtime job ${realtimeJobId}: schema comparison failed for ${objectApiName}: ${err?.message}`
      );
    }

    return { s3Path, schemaChanged, sizeInBytes };
  },
};
