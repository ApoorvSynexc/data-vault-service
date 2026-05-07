import { IDestinationConfig, IRealtimePayload } from '../../../models';
import { logger } from '../../../middlewares/logger';
import { httpRequest } from '../../../utils/http-request';
import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';
import { buildSchemaS3Key, toParquetDataType, schemasAreEqual } from '../../../utils/helper';
import { downloadFromS3, uploadToS3 } from '../../destination/s3';
import { ICrmRealtimeHandler } from '../types';
import { getObjectMetadata } from './bulk';

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
// Fetch latest schema from API using getObjectMetadata
// Returns schema with Parquet data types for consistency
// ---------------------------------------------------------------------------
const fetchLatestSchemaFromApi = async (
  crmId: string,
  objectApiName: string
): Promise<{ apiName: string; dataType: string; parquetDataType: string }[]> => {
  try {
    const { schema } = await getObjectMetadata(crmId, objectApiName);
    const schemaWithParquet = schema.map((field: any) => ({
      apiName: field.apiName,
      dataType: field.dataType,
      parquetDataType: toParquetDataType(field.dataType),
    }));
    logger.debug(
      `Real-time schema fetched from API for ${objectApiName}: ${schema.length} fields`
    );
    return schemaWithParquet;
  } catch (err: any) {
    logger.warn(
      `Failed to fetch latest schema from API for ${objectApiName}: ${err?.message}`
    );
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Derive schema from realtime payload records (fallback if API fetch fails)
// Realtime payloads carry no Salesforce type metadata, so every field is
// treated as STRING/BYTE_ARRAY — consistent with the bulk-job schema helper.
// ---------------------------------------------------------------------------
const deriveSchema = (
  records: Record<string, any>[]
): { apiName: string; dataType: string; parquetDataType: string }[] => {
  if (!records.length) {
    return [];
  }
  return Object.keys(records[0])
    .filter((k) => k !== 'attributes')
    .map((name) => ({
      apiName: name,
      dataType: 'STRING',
      parquetDataType: toParquetDataType('STRING'),
    }));
};

// ---------------------------------------------------------------------------
// Real-time schema comparison: fetch latest from API and compare with stored
// Returns { schemaChanged, latestSchema, detectedFields, removedFields }
// ---------------------------------------------------------------------------
const compareSchemaInRealtime = async (
  crmId: string,
  objectApiName: string,
  destConfig: IDestinationConfig,
  payloadRecords: Record<string, any>[]
): Promise<{
  schemaChanged: boolean;
  latestSchema: { apiName: string; dataType: string; parquetDataType: string }[];
  newFields: string[];
  removedFields: string[];
  incomingFields: string[];
}> => {
  // Fetch latest schema from API
  let latestSchema: { apiName: string; dataType: string; parquetDataType: string }[];
  try {
    latestSchema = await fetchLatestSchemaFromApi(crmId, objectApiName);
  } catch (err) {
    logger.warn(
      `Could not fetch latest schema from API, falling back to payload-derived schema`
    );
    latestSchema = deriveSchema(payloadRecords);
  }

  // Get incoming fields from payload records
  const incomingFields = payloadRecords.length
    ? Object.keys(payloadRecords[0]).filter((k) => k !== 'attributes')
    : [];

  // Get existing schema from S3
  const schemaKey = buildSchemaS3Key(crmId, objectApiName.split('/')[0], '', objectApiName);
  let existingSchema: { apiName: string; dataType: string; parquetDataType: string }[] = [];

  try {
    const existingBuffer = await downloadFromS3(destConfig, schemaKey);
    if (existingBuffer) {
      existingSchema = JSON.parse(existingBuffer.toString());
    }
  } catch (err: any) {
    logger.debug(`No existing schema found for ${objectApiName}, treating as new`);
  }

  // Compare schemas
  const existingFieldNames = new Set(existingSchema.map((f) => f.apiName));
  const latestFieldNames = new Set(latestSchema.map((f) => f.apiName));

  // Detect new and removed fields
  const newFields = Array.from(latestFieldNames).filter((f) => !existingFieldNames.has(f));
  const removedFields = Array.from(existingFieldNames).filter((f) => !latestFieldNames.has(f));

  // Check if schema truly changed
  const schemaChanged =
    !schemasAreEqual(existingSchema, latestSchema) ||
    newFields.length > 0 ||
    removedFields.length > 0;

  logger.info(
    `Real-time schema comparison for ${objectApiName}: changed=${schemaChanged}, newFields=${newFields.length}, removedFields=${removedFields.length}`
  );

  return {
    schemaChanged,
    latestSchema,
    newFields,
    removedFields,
    incomingFields,
  };
};

// ---------------------------------------------------------------------------
// Salesforce realtime handler — implements ICrmRealtimeHandler
// Performs real-time schema comparison using latest schema from API
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

    // ── Real-time schema comparison using latest schema from API ────────────
    // let schemaChanged = false;
    // let detectionInfo = {
    //   newFields: [] as string[],
    //   removedFields: [] as string[],
    //   incomingFields: [] as string[],
    // };

    // try {
    //   const schemaComparison = await compareSchemaInRealtime(
    //     crmId,
    //     objectApiName,
    //     destConfig,
    //     records
    //   );

    //   schemaChanged = schemaComparison.schemaChanged;
    //   detectionInfo = {
    //     newFields: schemaComparison.newFields,
    //     removedFields: schemaComparison.removedFields,
    //     incomingFields: schemaComparison.incomingFields,
    //   };

    //   // If schema changed, upload new schema and notify core service
    //   if (schemaChanged) {
    //     const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectApiName);
    //     const schemaBuffer = Buffer.from(
    //       JSON.stringify(schemaComparison.latestSchema, null, 2)
    //     );
    //     await uploadToS3(destConfig, schemaKey, schemaBuffer);

    //     logger.info(
    //       `Realtime job ${realtimeJobId}: schema changed for ${objectApiName}`,
    //       {
    //         newFields: schemaComparison.newFields,
    //         removedFields: schemaComparison.removedFields,
    //       }
    //     );

    //     // Notify core service of schema change
    //     await httpRequest({
    //       url: `${CORE_SERVICE}/v1/internal/backup-payload`,
    //       method: 'POST',
    //       body: JSON.stringify({
    //         eventType: 'schema.updated',
    //         crmId,
    //         objectName: objectApiName,
    //         backupJobId: realtimeJobId,
    //         backupConfigId,
    //         schemaChange: true,
    //       }),
    //       headers: {
    //         'x-internal-secret': INTERNAL_SECRET,
    //       },
    //     });

    //     logger.info(
    //       `Realtime job ${realtimeJobId}: core service notified of schema changes`
    //     );
    //   }
    // } catch (err: any) {
    //   logger.error(
    //     `Realtime job ${realtimeJobId}: schema comparison failed for ${objectApiName}: ${err?.message}`
    //   );
    //   // Continue processing even if schema comparison fails — don't block data upload
    // }

    // logger.info(
    //   `Realtime job ${realtimeJobId} completed with schemaChanged=${schemaChanged}`,
    //   detectionInfo
    // );
    return { s3Path, sizeInBytes };
  },
};
