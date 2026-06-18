import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { BACKUP_JOB_TABLE, JOB_STATUS, JOB_TYPE } from '../../constant';
import { IBackupJob, IDestinationConfig } from '../../models';
import { encrypt } from '../../utils/encryption';
import { incrementTableCounter } from '../counter';

/**
 * Parameters required to create or locate a realtime backup job for one webhook hit.
 * Every field here maps to a dimension used for deduplication or job identity:
 *   - backupConfigId: which user configuration triggered this backup
 *   - transactionId:  which Salesforce change event this hit belongs to
 *   - objectApiName:  which Salesforce object (e.g. Account, Contact)
 *   - operation:      what happened (INSERT, UPDATE, DELETE, UNDELETE)
 * Together these four fields define one unique job within the system.
 */
interface UpsertRealtimeBackupJobParams {
  userId: string;
  backupConfigId: string;
  crmId: string;
  crmName: string;
  destination: { type: string; config: IDestinationConfig };
  objectApiName: string;
  operation: string;
  transactionId: string;
  recordCount: number;
  spaceId?: string;
}

/**
 * getRealtimeJobById — direct PK lookup for a job whose ID is already known.
 *
 * WHY this exists alongside findActiveJobByTransaction:
 *   When a caller already holds a backupJobId (e.g. from a previous response), a direct
 *   GetItem on the primary key is O(1) and costs one read unit. The GSI query used by
 *   findActiveJobByTransaction must read and filter multiple items — it is slower and more
 *   expensive. Use this function whenever the job ID is available.
 */
const getRealtimeJobById = async (backupJobId: string): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_JOB_TABLE, Key: { backupJobId } })
  );
  return (result.Item as IBackupJob | undefined) ?? null;
};

/**
 * findActiveJobByTransaction — GSI lookup to check if a job already exists for this hit.
 *
 * WHY we query by backupConfigId + transactionId + objectApiName + operation (all four):
 *   - backupConfigId alone: too broad — returns all jobs for that config (hundreds).
 *   - +transactionId: narrows to one Salesforce change event, but one event can touch
 *     multiple objects (Account + Contact) and multiple operations (INSERT + UPDATE).
 *     Without the next two filters we might reuse the wrong job.
 *   - +objectApiName: one job per object; each object's data lands in its own S3 folder.
 *   - +operation: INSERT records and DELETE records go to separate S3 sub-folders
 *     (inserts/ vs deletes/) so they must be separate jobs.
 *   The combination of all four precisely identifies one independent accumulation bucket.
 *
 * WHY status is filtered to RUNNING or SUCCESS (not FAILED):
 *   A FAILED job is a dead end — its upload did not complete. If a subsequent hit arrives
 *   for the same transaction we want a fresh job, not to pile more records onto a broken one.
 *   Only RUNNING and SUCCESS jobs are healthy accumulation targets.
 *
 * WHY ScanIndexForward: false with Limit: 1:
 *   Returns the newest matching job first. In the rare case two jobs exist for the same
 *   key (e.g. a previous FAILED job was not filtered out due to a race), we always pick
 *   the most recently created one.
 */
const findActiveJobByTransaction = async (
  backupConfigId: string,
  transactionId: string,
  objectApiName: string,
  operation: string
): Promise<IBackupJob | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_JOB_TABLE,
      IndexName: 'backupConfigId-index',
      KeyConditionExpression: 'backupConfigId = :backupConfigId',
      FilterExpression:
        'jobType = :jobType AND transactionId = :transactionId AND objectApiName = :objectApiName AND #operation = :operation AND #status IN (:running, :success)',
      ExpressionAttributeNames: { '#status': 'status', '#operation': 'operation' },
      ExpressionAttributeValues: {
        ':backupConfigId': backupConfigId,
        ':jobType': JOB_TYPE.realtime,
        ':transactionId': transactionId,
        ':objectApiName': objectApiName,
        ':operation': operation,
        ':running': JOB_STATUS.running,
        ':success': JOB_STATUS.success,
      },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  return (result.Items?.[0] as IBackupJob | undefined) ?? null;
};

/**
 * createRealtimeJob — creates the job record for the first hit of a new transaction.
 *
 * WHY ConditionExpression: 'attribute_not_exists(backupJobId)':
 *   Salesforce can fire two hits for the same transaction simultaneously (fire-and-forget
 *   with no ordering guarantee). Without this condition, both hits could pass the
 *   findActiveJobByTransaction check (both read before either writes) and both would
 *   attempt to create a new job — resulting in duplicate job records for the same transaction.
 *
 *   attribute_not_exists(backupJobId) makes the write atomic: DynamoDB only allows the
 *   PutItem if no item with that backupJobId exists yet. Since both hits generate different
 *   UUIDs, one will always succeed and the other will succeed too (different PKs). But
 *   the real protection is the retry-find in upsertRealtimeBackupJob — see its comment.
 *
 * WHY destination config is encrypted before storing:
 *   The destination holds AWS access keys (or equivalent cloud credentials). Storing them
 *   in plaintext in DynamoDB would expose them to anyone with table read access. Encrypting
 *   at write-time means the raw credentials never touch the database. Only the runner, which
 *   has the decryption key at runtime, can reconstruct them.
 *
 * WHY transactionId is stored on the item:
 *   Storing transactionId here is what makes findActiveJobByTransaction work. The GSI
 *   queries on backupConfigId and then filters on transactionId; without the field on the
 *   item, the filter would never match and every hit would create a new job.
 *
 * WHY recordCount is initialized from the first hit's record count (not 0):
 *   The first hit's records are real data that must be counted. Initializing to 0 and
 *   then using ADD would require an extra update step. Since createRealtimeJob is only
 *   called once per job, setting the initial value directly is correct. Subsequent hits
 *   use the ADD path in updateRealtimeJob to accumulate.
 */
const createRealtimeJob = async (
  params: UpsertRealtimeBackupJobParams
): Promise<IBackupJob> => {
  const {
    userId, backupConfigId, crmId, crmName, destination,
    objectApiName, operation, transactionId, recordCount, spaceId,
  } = params;

  const now = new Date().toISOString();
  const encryptedDest = encrypt(JSON.stringify(destination.config));

  const item: IBackupJob = {
    backupJobId: uuidv4(),
    jobType: JOB_TYPE.realtime as 'REALTIME',
    userId,
    backupConfigId,
    crmId,
    crmName,
    destination: { type: destination.type, ...encryptedDest },
    objectApiName,
    operation,
    transactionId,
    recordCount,
    sizeInBytes: 0,
    status: JOB_STATUS.running,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    ...(spaceId && { spaceId }),
  };

  await docClient.send(
    new PutCommand({
      TableName: BACKUP_JOB_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(backupJobId)',
    })
  );

  await Promise.all([
    incrementTableCounter(BACKUP_JOB_TABLE, userId),
    incrementTableCounter(BACKUP_JOB_TABLE, backupConfigId),
  ]);

  return item;
};

/**
 * upsertRealtimeBackupJob — resolves which job a webhook hit belongs to.
 *
 * WHY "upsert" instead of "create":
 *   Salesforce sends multiple HTTP hits per logical transaction. We want one job record
 *   per transaction (clean UI, accurate totals, one S3 folder). "Upsert" captures this:
 *   find the existing job and return it, or create a new one if this is the first hit.
 *
 * THE HAPPY PATHS:
 *   1. Second+ hit for a known transaction:
 *      findActiveJobByTransaction returns the existing job → return immediately.
 *      No write needed; the runner will atomically add to the existing record.
 *
 *   2. First hit for a new transaction:
 *      findActiveJobByTransaction returns null → createRealtimeJob succeeds → return new job.
 *
 * THE RACE CONDITION (two simultaneous first-hits for the same transaction):
 *   Both hits call findActiveJobByTransaction and both get null (no job exists yet).
 *   Both call createRealtimeJob with different UUIDs.
 *   DynamoDB processes both PutItems — both succeed because the PKs differ.
 *   Now two jobs exist for the same transaction key.
 *
 *   WAIT — why doesn't attribute_not_exists prevent this?
 *   attribute_not_exists(backupJobId) only prevents overwriting an item with the SAME PK.
 *   Since each hit generates a new UUID, they write to different PKs and both succeed.
 *   The real deduplication guard is in the FIND step, not the PUT step.
 *
 *   This means if two first-hits race, each creates its own job and they accumulate
 *   independently. This is an accepted trade-off: it's rare (requires exact same-millisecond
 *   arrival), and the alternative (a distributed lock) adds latency and complexity.
 *   The UI shows at most two jobs for one transaction edge case instead of one; data is
 *   never lost and no writes are corrupted.
 *
 *   If a different kind of race occurs — two hits racing on a non-existent PK with the
 *   SAME UUID (UUID collision, effectively impossible) — the catch block handles it by
 *   retrying the find, which now returns the winner's job.
 */
const upsertRealtimeBackupJob = async (
  params: UpsertRealtimeBackupJobParams
): Promise<IBackupJob> => {
  const { backupConfigId, transactionId, objectApiName, operation } = params;

  const existingJob = await findActiveJobByTransaction(backupConfigId, transactionId, objectApiName, operation);
  if (existingJob) {
    return existingJob;
  }

  try {
    return await createRealtimeJob(params);
  } catch (err: any) {
    /**
     * ConditionalCheckFailedException means a job with this PK was created between our
     * read and our write (UUID collision — vanishingly rare). Retry the find to return
     * the job that won the race instead of propagating a misleading error.
     */
    if (err.name === 'ConditionalCheckFailedException') {
      const racedJob = await findActiveJobByTransaction(backupConfigId, transactionId, objectApiName, operation);
      if (racedJob) {
        return racedJob;
      }
    }
    throw err;
  }
};

/**
 * Parameters for updating an existing realtime job after a hit completes (or fails).
 *
 * WHY increments instead of absolute values for sizeInBytes and recordCount:
 *   Two hits can finish their S3 uploads nearly simultaneously. If both used SET, the
 *   second write would overwrite the first's contribution and the totals would be wrong.
 *   Passing a delta (increment) allows DynamoDB's atomic ADD to merge both in the
 *   storage layer — order and timing don't matter, every hit's numbers are preserved.
 *
 * WHY the other fields use plain SET (last-write-wins):
 *   status, s3Path, lastCompletedAt, schemaChanged, errorMessage — these are scalar
 *   observations about the most recent hit, not running totals. Whichever hit writes
 *   last is fine: status converges to SUCCESS once all hits finish; s3Path is just a
 *   reference pointer (all files are in S3 regardless); lastCompletedAt naturally
 *   ends up as the timestamp of the last hit to complete.
 */
interface UpdateRealtimeJobParams {
  backupJobId: string;
  status: string;
  sizeInBytesIncrement?: number;
  recordCountIncrement?: number;
  startedAt?: string;
  lastCompletedAt?: string;
  s3Path?: string;
  schemaChanged?: boolean;
  errorMessage?: string;
}

/**
 * updateRealtimeJob — writes a single DynamoDB UpdateItem combining SET and ADD clauses.
 *
 * WHY both SET and ADD are used in the same expression:
 *   DynamoDB UpdateExpression supports multiple actions in one atomic operation.
 *   Using one round-trip instead of two avoids a window where status is SUCCESS but
 *   sizeInBytes hasn't been incremented yet (or vice versa), which would show stale
 *   data in the UI between two sequential writes.
 *
 * WHY #status and #operation are aliased with ExpressionAttributeNames:
 *   "status" and "operation" are DynamoDB reserved words. Without the # alias the
 *   request would fail with a ParserException. Using attribute name aliases is the
 *   standard DynamoDB workaround for reserved word conflicts.
 */
const updateRealtimeJob = async (params: UpdateRealtimeJobParams): Promise<void> => {
  const {
    backupJobId, status, sizeInBytesIncrement, recordCountIncrement,
    startedAt, lastCompletedAt, s3Path, schemaChanged, errorMessage,
  } = params;

  const now = new Date().toISOString();
  const setParts: string[] = ['#status = :status', 'updatedAt = :updatedAt'];
  const addParts: string[] = [];
  const expressionNames: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, any> = { ':status': status, ':updatedAt': now };

  if (startedAt) {
    setParts.push('startedAt = :startedAt');
    expressionValues[':startedAt'] = startedAt;
  }
  if (lastCompletedAt) {
    setParts.push('lastCompletedAt = :lastCompletedAt');
    expressionValues[':lastCompletedAt'] = lastCompletedAt;
  }
  if (s3Path !== undefined) {
    setParts.push('s3Path = :s3Path');
    expressionValues[':s3Path'] = s3Path;
  }
  if (schemaChanged !== undefined) {
    setParts.push('schemaChanged = :schemaChanged');
    expressionValues[':schemaChanged'] = schemaChanged;
  }
  if (errorMessage !== undefined) {
    setParts.push('errorMessage = :errorMessage');
    expressionValues[':errorMessage'] = errorMessage;
  }
  if (sizeInBytesIncrement !== undefined) {
    addParts.push('sizeInBytes :sizeInBytesIncrement');
    expressionValues[':sizeInBytesIncrement'] = sizeInBytesIncrement;
  }
  if (recordCountIncrement !== undefined) {
    addParts.push('recordCount :recordCountIncrement');
    expressionValues[':recordCountIncrement'] = recordCountIncrement;
  }

  const updateExpression = [
    `SET ${setParts.join(', ')}`,
    ...(addParts.length ? [`ADD ${addParts.join(', ')}`] : []),
  ].join(' ');

  await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_JOB_TABLE,
      Key: { backupJobId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    })
  );
};

export { upsertRealtimeBackupJob, updateRealtimeJob, getRealtimeJobById };
