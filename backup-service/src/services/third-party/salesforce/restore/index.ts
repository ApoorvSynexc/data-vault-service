import { logger } from '../../../../middlewares/logger';
import { IDestinationConfig, IRestoreConflict } from '../../../../models';
import { listS3Objects, streamCsvLinesFromS3 } from '../../../destination/s3';
import { updateRestoreObject } from '../../../restore-job';
import { SalesforceTokens } from '../api-request';
import {
  createBulkJob,
  uploadDataToJob,
  closeBulkJob,
  pollBulkJobUntilDone,
  getFailedResults,
} from './bulk';

interface RunSalesforceRestorePayload {
  restoreId: string;
  restoreJobId: string;
  object: { id: string; name: string; status: string };
  sourceS3Credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    region: string;
    csvFilePath: string;
    backupConfigId: string;
  };
  destinationSalesforceCredentials: {
    access_token: string;
    refresh_token: string;
    instanceUrl: string;
  };
  conflict: IRestoreConflict;
}

// Salesforce's own docs disagree on whether the 150 MB ingest limit is per upload
// request or per whole job (see the two quotes on this in the header comment
// below), and that 150 MB is measured as base64-encoded size even though this
// data is uploaded as raw text/csv. Staying well under 100 MB raw per JOB is the
// one interpretation that's safe either way.
const MAX_CHUNK_BYTES = 100 * 1024 * 1024;

interface CsvChunk {
  header: string;
  rows: string[];
  byteLength: number;
}

const newChunk = (header: string): CsvChunk => ({
  header,
  rows: [],
  byteLength: Buffer.byteLength(header, 'utf8'),
});

const parseCsvRow = (line: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
};

const parseFirstNErrors = (failedCsv: string, limit: number): string[] => {
  const lines = failedCsv.split('\n').filter((l) => l.trim());
  if (lines.length < 2) {
    return [];
  }
  const headers = parseCsvRow(lines[0]);
  const errorColIndex = headers.findIndex((h) => h.trim() === 'sf__Error');
  if (errorColIndex === -1) {
    return [];
  }
  return lines
    .slice(1, limit + 1)
    .map((line) => parseCsvRow(line)[errorColIndex]?.trim())
    .filter(Boolean) as string[];
};

// Submits one closed Bulk API 2.0 ingest job for a single ≤MAX_CHUNK_BYTES CSV chunk.
const submitIngestChunk = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectName: string,
  operation: 'insert' | 'update' | 'upsert',
  externalIdFieldName: string | undefined,
  chunk: CsvChunk
): Promise<{ processed: number; failed: number; jobId: string; errors: string[] }> => {
  const csvBody = [chunk.header, ...chunk.rows].join('\n');
  const job = await createBulkJob({
    instanceUrl,
    tokens,
    objectName,
    operation,
    externalIdFieldName,
  });
  await uploadDataToJob(instanceUrl, tokens, job.id, csvBody);
  await closeBulkJob(instanceUrl, tokens, job.id);
  const status = await pollBulkJobUntilDone(instanceUrl, tokens, job.id);

  let errors: string[] = [];
  if ((status.numberRecordsFailed ?? 0) > 0 || status.state === 'Failed') {
    const failedCsv = await getFailedResults(instanceUrl, tokens, job.id);
    errors = parseFirstNErrors(failedCsv, 25);
  }

  return {
    jobId: job.id,
    processed: status.numberRecordsProcessed ?? 0,
    failed: status.numberRecordsFailed ?? 0,
    errors,
  };
};

// Streams every backed-up CSV file for this object from S3 — one line at a time,
// never buffering a whole file into memory — and submits one Bulk API 2.0 ingest
// job per ~100 MB chunk. A single backed-up file can itself be anywhere from 1 KB
// to multiple GB, so chunking happens across line boundaries within and across
// files, not per-file.
const restoreObjectData = async (
  restoreJobId: string,
  s3Config: IDestinationConfig,
  csvFilePath: string,
  objectName: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  operation: 'insert' | 'update' | 'upsert',
  externalIdFieldName: string
): Promise<string[]> => {
  const keys = await listS3Objects(s3Config, `${csvFilePath}/${objectName}`);

  if (!keys.length) {
    await updateRestoreObject({
      restoreJobId,
      objectName,
      processedRecordCount: 0,
      failedRecordCount: 0,
      status: 'SUCCESS',
    });

    console.log(`[Restore] No backed-up data found for object ${objectName} under ${csvFilePath}`);
    return [];
  }

  const submittedJobIds: string[] = [];
  let header: string | null = null;
  let chunk: CsvChunk | null = null;

  const flushChunk = async () => {
    if (!chunk || !chunk.rows.length) {
      return;
    }
    const job = await submitIngestChunk(
      instanceUrl,
      tokens,
      objectName,
      operation,
      externalIdFieldName,
      chunk
    );
    submittedJobIds.push(job.jobId);
    // Accumulate this chunk's processed/failed counts onto the object's running
    // total — a single object can span multiple chunks, so this fires once per
    // chunk rather than once at the very end of the object.
    await updateRestoreObject({
      restoreJobId,
      objectName,
      processedRecordCount: job.processed,
      failedRecordCount: job.failed,
      status: job.failed ? 'FAILED' : 'SUCCESS',
      errors: job.errors.length ? job.errors : undefined,
    });
    chunk = newChunk(header!);
  };

  for (const key of keys) {
    let isFirstLineOfFile = true;
    for await (const line of streamCsvLinesFromS3(s3Config, key)) {
      if (isFirstLineOfFile) {
        isFirstLineOfFile = false;
        // Capture the header once, from the first file only — every subsequent
        // file's own header line is a duplicate and gets skipped here.
        if (header === null) {
          header = line;
          chunk = newChunk(header);
        }
        continue;
      }
      if (!line) {
        continue; // skip blank lines
      }

      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline joiner
      if (chunk!.byteLength + lineBytes > MAX_CHUNK_BYTES) {
        await flushChunk();
      }
      chunk!.rows.push(line);
      chunk!.byteLength += lineBytes;
    }
  }

  await flushChunk();

  if (!submittedJobIds.length) {
    throw new Error(`No data rows found for object ${objectName}`);
  }
  return submittedJobIds;
};

export const runSalesforceRestore = async (
  payload: RunSalesforceRestorePayload
): Promise<'SUCCESS' | 'FAILED'> => {
  let externalIdFieldName = '';
  const {
    restoreId,
    restoreJobId,
    object,
    sourceS3Credentials,
    destinationSalesforceCredentials,
    conflict,
  } = payload;

  logger.info(
    `[restore] execution requested, restoreId=${restoreId}, restoreJobId=${restoreJobId}, objectId=${object.id}, objectName=${object.name}, restoreMode=${conflict.restoreMode}`
  );

  if (conflict.restoreMode === 'SKIP') {
    logger.info(
      `[restore] skipping object per restoreMode=SKIP, restoreId=${restoreId}, restoreJobId=${restoreJobId}, objectName=${object.name}`
    );
    return 'SUCCESS';
  }

  let operation: 'insert' | 'update' | 'upsert';
  switch (conflict.restoreMode) {
    case 'APPEND_NEW':
      operation = 'insert';
      break;
    case 'OVERWRITE':
      operation = 'upsert';
      externalIdFieldName = 'Id'; // Salesforce's own docs say this is the only supported external ID field for upsert-ing to existing records
      break;
    case 'REPLACE_ENTIRE_OBJECT':
      throw new Error('REPLACE_ENTIRE_OBJECT restore mode is not implemented yet');
    default:
      throw new Error(`Unsupported restoreMode: ${conflict.restoreMode}`);
  }

  const s3Config: IDestinationConfig = {
    bucketName: sourceS3Credentials.bucketName,
    region: sourceS3Credentials.region,
    accessKeyId: sourceS3Credentials.accessKeyId,
    secretAccessKey: sourceS3Credentials.secretAccessKey,
  };

  const tokens: SalesforceTokens = {
    accessToken: destinationSalesforceCredentials.access_token,
    refreshToken: destinationSalesforceCredentials.refresh_token,
    crmId: '', // not carried on this payload — unused by the plain-fetch calls below
    backupConfigId: sourceS3Credentials.backupConfigId, // placeholder — no refresh path scoped to restores yet
  };

  await restoreObjectData(
    restoreJobId,
    s3Config,
    sourceS3Credentials.csvFilePath,
    object.name,
    destinationSalesforceCredentials.instanceUrl,
    tokens,
    operation,
    externalIdFieldName
  );

  logger.info(
    `[restore] bulk ingest jobs submitted, objectName: ${object.name}, restoreJobId: ${restoreJobId}, operation: ${operation}`
  );
  return 'SUCCESS';
};
