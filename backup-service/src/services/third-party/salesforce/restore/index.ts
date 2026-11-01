import { logger } from '../../../../middlewares/logger';
import { STATUS, JOB_OBJECT_STATUS, MAX_STORED_ERRORS_COUNT } from '../../../../constant';
import { IDestinationConfig, IRestoreConflict } from '../../../../models';
import { ISourceS3Keys } from '../../../../models/restore-job';
import {
  downloadFromS3,
  listS3Objects,
  streamCsvLinesFromS3,
  uploadToS3,
} from '../../../destination/s3';
import { updateRestoreObject } from '../../../restore-job';
import { SalesforceTokens } from '../api-request';
import {
  createBulkJob,
  uploadDataToJob,
  closeBulkJob,
  abortBulkJob,
  getBulkJobStatus,
  pollBulkJobUntilDone,
  getFailedResults,
  getSuccessfulResults,
  BulkJobState,
} from './bulk';

interface RunSalesforceRestorePayload {
  restoreId: string;
  restoreJobId: string;
  object: { id: string; name: string; status?: string };
  sourceS3Credentials: ISourceS3Keys & {
    bucketName: string;
    region: string;
    csvFilePath: string;
    backupConfigId: string;
  };
  destinationSalesforceCredentials: {
    access_token: string;
    refresh_token?: string;
    instanceUrl: string;
    userId?: string;
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

// Reduces a successfulResults CSV (which carries every original column plus
// Salesforce's sf__Id/sf__Created columns) down to just the ids of newly
// created records (sf__Created === "true"), under a plain "Id" header —
// upsert-ed rows that matched an existing record are excluded.
const extractSuccessfulIdsCsv = (successfulCsv: string): string => {
  const lines = successfulCsv
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim());
  if (!lines.length) {
    return 'Id';
  }
  const headers = parseCsvRow(lines[0]);
  const idColIndex = headers.findIndex((h) => h.trim() === 'sf__Id');
  const createdColIndex = headers.findIndex((h) => h.trim() === 'sf__Created');
  if (idColIndex === -1) {
    return 'Id';
  }
  const ids = lines
    .slice(1)
    .filter(
      (line) => createdColIndex === -1 || parseCsvRow(line)[createdColIndex]?.trim() === 'true'
    )
    .map((line) => parseCsvRow(line)[idColIndex]?.trim() ?? '');
  return ['Id', ...ids].join('\n');
};

// ---------------------------------------------------------------------------
// Chunk checkpoints — make a restore safe to resume (design doc §10.5).
//
// Chunks are deterministic: the same sorted S3 keys split at the same byte
// limit always yield the same chunk N. Each chunk's ingest job is recorded in
// S3 next to the restore's CSVs:
//   CREATED — job created; it may or may not have processed rows yet
//   DONE    — job reached a terminal state; counts already recorded
// On a re-run a DONE chunk is skipped, and a CREATED one is reconciled
// against Salesforce instead of being resubmitted, so a resumed insert can
// never create the same records twice.
// ---------------------------------------------------------------------------

interface ChunkCheckpoint {
  jobId: string;
  phase: 'CREATED' | 'DONE';
  state?: BulkJobState;
  processed?: number;
  failed?: number;
  errors?: string[];
}

// Own root, outside every data prefix restoreObjectData lists — a checkpoint
// must never be read back as a CSV data file.
const chunkCheckpointKey = (
  restoreJobId: string,
  type: 'RESTORE' | 'ROLLBACK',
  objectName: string,
  operation: string,
  chunkIndex: number
) =>
  `checkpoints/restore-jobs/${restoreJobId}/${type.toLowerCase()}/${objectName}/${operation}/chunk-${String(chunkIndex).padStart(5, '0')}.json`;

const readChunkCheckpoint = async (
  s3Config: IDestinationConfig,
  key: string
): Promise<ChunkCheckpoint | null> => {
  const body = await downloadFromS3(s3Config, key);
  return body ? (JSON.parse(body.toString('utf8')) as ChunkCheckpoint) : null;
};

const writeChunkCheckpoint = (
  s3Config: IDestinationConfig,
  key: string,
  checkpoint: ChunkCheckpoint
) => uploadToS3(s3Config, key, Buffer.from(JSON.stringify(checkpoint), 'utf8'));

const isNotFound = (error: any) => String(error?.message ?? '').startsWith('HTTP Error 404');

// For a chunk whose job was created in an earlier run: returns the job id to
// keep polling, or null when the chunk must be resubmitted (the job never got
// past Open, so nothing was processed). Throws when the job can no longer be
// checked — resubmitting blindly could duplicate records.
const reconcileCreatedChunk = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  checkpoint: ChunkCheckpoint
): Promise<string | null> => {
  let state: BulkJobState;
  try {
    state = (await getBulkJobStatus(instanceUrl, tokens, checkpoint.jobId)).state;
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `Ingest job ${checkpoint.jobId} from an earlier run no longer exists in Salesforce; stopped to avoid duplicating records. Verify the data and start a new restore.`,
        { cause: error }
      );
    }
    throw error;
  }

  if (state === 'Open') {
    await abortBulkJob(instanceUrl, tokens, checkpoint.jobId);
    return null;
  }
  return state === 'Aborted' ? null : checkpoint.jobId;
};

// Submits one closed Bulk API 2.0 ingest job for a single ≤MAX_CHUNK_BYTES CSV chunk.
const submitIngestChunk = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectName: string,
  operation: 'insert' | 'update' | 'upsert' | 'delete',
  externalIdFieldName: string | undefined,
  chunk: CsvChunk,
  s3Config: IDestinationConfig,
  successfulResultsPath: string,
  type: 'RESTORE' | 'ROLLBACK',
  checkpointKey: string
): Promise<{
  processed: number;
  failed: number;
  jobId: string;
  errors: string[];
  status: BulkJobState;
  // Already DONE in an earlier run — its counts were recorded then.
  skipped: boolean;
}> => {
  const existing = await readChunkCheckpoint(s3Config, checkpointKey);
  if (existing?.phase === 'DONE') {
    return {
      jobId: existing.jobId,
      processed: existing.processed ?? 0,
      failed: existing.failed ?? 0,
      errors: existing.errors ?? [],
      status: existing.state ?? 'JobComplete',
      skipped: true,
    };
  }

  let jobId = existing ? await reconcileCreatedChunk(instanceUrl, tokens, existing) : null;
  if (jobId) {
    logger.info(
      `[Restore] Resuming ingest job ${jobId} for object ${objectName} from an earlier run`
    );
  } else {
    const csvBody = [chunk.header, ...chunk.rows].join('\n');
    const created = await createBulkJob({
      instanceUrl,
      tokens,
      objectName,
      operation,
      externalIdFieldName,
    });
    jobId = created.id;
    await writeChunkCheckpoint(s3Config, checkpointKey, { jobId, phase: 'CREATED' });
    await uploadDataToJob(instanceUrl, tokens, jobId, csvBody);
    await closeBulkJob(instanceUrl, tokens, jobId);
  }
  const status = await pollBulkJobUntilDone(instanceUrl, tokens, jobId);

  const processed = status.numberRecordsProcessed ?? 0;
  const failed = status.numberRecordsFailed ?? 0;

  let errors: string[] = [];
  if (failed > 0 || status.state === 'Failed' || status.state === 'Aborted') {
    const failedCsv = await getFailedResults(instanceUrl, tokens, jobId);
    errors = parseFirstNErrors(failedCsv, MAX_STORED_ERRORS_COUNT);
    errors = errors.length ? errors : [status.errorMessage ?? 'An error occurred'];
  }

  logger.debug(
    `[Restore] Polling for completion for object ${objectName}, status=${status.state}, failed=${failed}, errors.length=${errors.length}`
  );

  // ponytail: update has no pre-change snapshot to roll back to (only ids are
  // captured), so it can't safely produce a rollback artifact — revisit if
  // update rollback becomes a real requirement.
  if (type === 'RESTORE' && operation === 'insert' && processed - failed > 0) {
    const successfulCsv = await getSuccessfulResults(instanceUrl, tokens, jobId);
    const idsOnlyCsv = extractSuccessfulIdsCsv(successfulCsv);
    await uploadToS3(
      s3Config,
      `${successfulResultsPath}/${jobId}.csv`,
      Buffer.from(idsOnlyCsv, 'utf8')
    );
  }

  await writeChunkCheckpoint(s3Config, checkpointKey, {
    jobId: jobId,
    phase: 'DONE',
    state: status.state,
    processed,
    failed,
    errors,
  });

  return {
    jobId: jobId,
    processed,
    status: status.state,
    failed,
    errors,
    skipped: false,
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
  baseCsvFilePath: string,
  objectName: string,
  instanceUrl: string,
  tokens: SalesforceTokens,
  operation: 'insert' | 'update' | 'upsert' | 'delete',
  externalIdFieldName: string,
  type: 'RESTORE' | 'ROLLBACK'
): Promise<string[]> => {
  let csvFilePath = baseCsvFilePath;
  if (type === 'RESTORE') {
    csvFilePath = `${baseCsvFilePath}/${objectName}/csv/${operation}`;
  }
  const keys = await listS3Objects(s3Config, `${csvFilePath}`);

  if (!keys.length) {
    await updateRestoreObject({
      restoreJobId,
      objectName,
      processedRecordCount: 0,
      failedRecordCount: 0,
      status:
        type === 'RESTORE'
          ? JOB_OBJECT_STATUS.restoreCompleted
          : JOB_OBJECT_STATUS.rollbackCompleted,
    });

    return [];
  }

  logger.info(
    `[Restore] Found ${keys.length} backed-up data files for object ${objectName}, restoreJobId=${restoreJobId}`
  );

  const successfulResultsPath = `${baseCsvFilePath}/rollback/${objectName}/delete`;
  const submittedJobIds: string[] = [];
  let header: string | null = null;
  let chunk: CsvChunk | null = null;
  // Salesforce's Bulk API 'delete' job rejects a batch containing any column
  // besides the id ("InvalidBatch: The 'delete' batch must contain only ids")
  // — the backed-up CSV carries every field, so a delete pass has to project
  // each row down to just its id column before upload, unlike insert/update/
  // upsert which pass the CSV through unchanged.
  let idColumnIndex = -1;

  let chunkIndex = 0;

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
      chunk,
      s3Config,
      successfulResultsPath,
      type,
      chunkCheckpointKey(restoreJobId, type, objectName, operation, chunkIndex++)
    );
    submittedJobIds.push(job.jobId);
    if (job.skipped) {
      logger.info(
        `[Restore] Skipping chunk already ingested in an earlier run, object ${objectName}, jobId=${job.jobId}`
      );
      chunk = newChunk(header!);
      return;
    }
    // Accumulate this chunk's processed/failed counts onto the object's running
    // total — a single object can span multiple chunks, so this fires once per
    // chunk rather than once at the very end of the object.
    const jobFailed =
      job.status === 'Failed' || job.status === 'Aborted' || job.failed || job.errors.length;
    await updateRestoreObject({
      restoreJobId,
      objectName,
      ...(type === 'RESTORE'
        ? {
            processedRecordCount: job.processed,
            failedRecordCount: job.failed,
          }
        : {
            rollbackProcessedRecordCount: job.processed,
            rollbackFailedRecordCount: job.failed,
          }),

      status: jobFailed
        ? type === 'RESTORE'
          ? JOB_OBJECT_STATUS.restoreFailed
          : JOB_OBJECT_STATUS.rollbackFailed
        : type === 'RESTORE'
          ? JOB_OBJECT_STATUS.restoreCompleted
          : JOB_OBJECT_STATUS.rollbackCompleted,
      errors: job.errors.length ? job.errors : undefined,
    });
    logger.info(
      `[Restore] Ingested chunk for object ${objectName}, jobId=${job.jobId}, chunkCount=${chunk.rows.length || ''}, processed=${job.processed}, failed=${job.failed}`
    );
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
          if (operation === 'delete') {
            idColumnIndex = parseCsvRow(line).findIndex(
              (field) => field.trim().toLowerCase() === externalIdFieldName.toLowerCase()
            );
            if (idColumnIndex === -1) {
              throw new Error(
                `Column "${externalIdFieldName}" not found in backed-up data for object ${objectName}`
              );
            }
            header = externalIdFieldName;
          } else {
            header = line;
          }
          chunk = newChunk(header);
        }
        continue;
      }
      if (!line) {
        continue; // skip blank lines
      }

      const row = operation === 'delete' ? (parseCsvRow(line)[idColumnIndex] ?? '') : line;
      if (operation === 'delete' && !row) {
        continue; // no id to delete on this row
      }

      const lineBytes = Buffer.byteLength(row, 'utf8') + 1; // +1 for the newline joiner
      if (chunk!.byteLength + lineBytes > MAX_CHUNK_BYTES) {
        await flushChunk();
      }
      chunk!.rows.push(row);
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
): Promise<typeof STATUS.success | typeof STATUS.failed> => {
  const externalIdFieldName = 'Id';
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

  // if (conflict.restoreMode === 'SKIP') {
  //   logger.info(
  //     `[restore] skipping object per restoreMode=SKIP, restoreId=${restoreId}, restoreJobId=${restoreJobId}, objectName=${object.name}`
  //   );
  //   return STATUS.success;
  // }

  // let operation: 'insert' | 'update' | 'upsert';
  // switch (conflict.restoreMode) {
  //   case 'APPEND_NEW':
  //     operation = 'insert';
  //     break;
  //   case 'OVERWRITE':
  //     operation = 'upsert';
  //     externalIdFieldName = 'Id'; // Salesforce's own docs say this is the only supported external ID field for upsert-ing to existing records
  //     break;
  //   case 'REPLACE_ENTIRE_OBJECT':
  //     throw new Error('REPLACE_ENTIRE_OBJECT restore mode is not implemented yet');
  //   default:
  //     throw new Error(`Unsupported restoreMode: ${conflict.restoreMode}`);
  // }

  const s3Config: IDestinationConfig = {
    bucketName: sourceS3Credentials.bucketName,
    region: sourceS3Credentials.region,
    authType: sourceS3Credentials.authType,
    roleArn: sourceS3Credentials.roleArn,
    externalId: sourceS3Credentials.externalId,
    accessKeyId: sourceS3Credentials.accessKeyId,
    secretAccessKey: sourceS3Credentials.secretAccessKey,
    sessionToken: sourceS3Credentials.sessionToken,
  };

  const tokens: SalesforceTokens = {
    accessToken: destinationSalesforceCredentials.access_token,
    refreshToken: destinationSalesforceCredentials.refresh_token,
    crmId: '', // not carried on this payload — unused by the plain-fetch calls below
    backupConfigId: sourceS3Credentials.backupConfigId,
    // Refreshes go to the destination org's user; the gate is shared by every
    // object in this restore job.
    userId: destinationSalesforceCredentials.userId,
    jobId: restoreJobId,
    jobType: 'RESTORE',
  };

  for (const operation of ['insert', 'update'] as const) {
    await restoreObjectData(
      restoreJobId,
      s3Config,
      sourceS3Credentials.csvFilePath,
      object.name,
      destinationSalesforceCredentials.instanceUrl,
      tokens,
      operation,
      externalIdFieldName,
      'RESTORE'
    );

    logger.info(
      `[restore] bulk ingest jobs submitted, objectName: ${object.name}, restoreJobId: ${restoreJobId}, operation: ${operation}`
    );
  }

  return STATUS.success;
};

export const runSalesforceRollback = async (
  payload: RunSalesforceRestorePayload
): Promise<typeof STATUS.success | typeof STATUS.failed> => {
  const externalIdFieldName = 'Id';
  const { restoreId, restoreJobId, object, sourceS3Credentials, destinationSalesforceCredentials } =
    payload;

  logger.info(
    `[Rollback] execution requested, restoreId=${restoreId}, restoreJobId=${restoreJobId}, objectId=${object.id}, objectName=${object.name}`
  );

  const s3Config: IDestinationConfig = {
    bucketName: sourceS3Credentials.bucketName,
    region: sourceS3Credentials.region,
    authType: sourceS3Credentials.authType,
    roleArn: sourceS3Credentials.roleArn,
    externalId: sourceS3Credentials.externalId,
    accessKeyId: sourceS3Credentials.accessKeyId,
    secretAccessKey: sourceS3Credentials.secretAccessKey,
    sessionToken: sourceS3Credentials.sessionToken,
  };

  const tokens: SalesforceTokens = {
    accessToken: destinationSalesforceCredentials.access_token,
    refreshToken: destinationSalesforceCredentials.refresh_token,
    crmId: '', // not carried on this payload — unused by the plain-fetch calls below
    backupConfigId: sourceS3Credentials.backupConfigId,
    userId: destinationSalesforceCredentials.userId,
    jobId: restoreJobId,
    jobType: 'ROLLBACK',
  };

  const path = `${sourceS3Credentials.csvFilePath}/rollback/${object.name}`;
  const keys = await listS3Objects(s3Config, path);

  if (keys.length) {
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const splitKeys = key.split('/');
      let operation = splitKeys[splitKeys.length - 1] as 'update' | 'delete';

      if (!['update', 'delete'].includes(operation)) {
        operation = splitKeys[splitKeys.length - 2] as 'update' | 'delete';
      }

      await restoreObjectData(
        restoreJobId,
        s3Config,
        path,
        object.name,
        destinationSalesforceCredentials.instanceUrl,
        tokens,
        operation,
        externalIdFieldName,
        'ROLLBACK'
      );
    }
  }

  logger.info(
    `[restore] bulk ingest jobs submitted, objectName: ${object.name}, restoreJobId: ${restoreJobId}, operation: ${'upsert'}`
  );
  return STATUS.success;
};
