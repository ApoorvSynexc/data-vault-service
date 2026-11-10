import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { BACKUP_RANGE_TABLE, JOB_OBJECT_STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupRange, IBackupRangePlan, buildRangeKey, planRangeKey } from '../../models';

const RANGE_TTL_SECONDS = 90 * 24 * 60 * 60;
const TABLE_RECHECK_MS = 5 * 60 * 1000;
const BATCH_WRITE_LIMIT = 25;
const TRANSACT_LIMIT = 100;
const TERMINAL: string[] = [JOB_OBJECT_STATUS.uploadCompleted, JOB_OBJECT_STATUS.split];

export const expiresAtFromNow = (): number => Math.floor(Date.now() / 1000) + RANGE_TTL_SECONDS;

export { buildRangeKey, planRangeKey };

// ---------------------------------------------------------------------------
// Table availability. The table is created by infrastructure; if it is missing
// (or unreadable) the caller falls back to the single-query export instead of
// failing the backup. A positive result is cached; a negative one is re-checked
// every few minutes so the feature turns on once the table exists.
// ---------------------------------------------------------------------------
let tableAvailable: boolean | undefined;
let tableCheckedAt = 0;

export const isRangeTableAvailable = async (): Promise<boolean> => {
  if (tableAvailable === true) {
    return true;
  }
  if (tableAvailable === false && Date.now() - tableCheckedAt < TABLE_RECHECK_MS) {
    return false;
  }
  tableCheckedAt = Date.now();
  try {
    await docClient.send(
      new QueryCommand({
        TableName: BACKUP_RANGE_TABLE,
        KeyConditionExpression: 'backupJobId = :j',
        ExpressionAttributeValues: { ':j': '__probe__' },
        Limit: 1,
      })
    );
    tableAvailable = true;
  } catch (err: any) {
    tableAvailable = false;
    logger.error(
      `[range] range table ${BACKUP_RANGE_TABLE} is not usable (${err?.name ?? 'error'}): range export disabled until it is`
    );
  }
  return tableAvailable;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const getRangePlan = async (
  backupJobId: string,
  objectKey: string
): Promise<IBackupRangePlan | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: BACKUP_RANGE_TABLE,
      Key: { backupJobId, rangeKey: planRangeKey(objectKey) },
    })
  );
  return (result.Item as IBackupRangePlan) ?? null;
};

// Range rows of one object, in run order (DynamoDB sorts the sort key by bytes,
// which matches the range-id ordering described in models/backup-range).
export const listRanges = async (
  backupJobId: string,
  objectKey: string
): Promise<IBackupRange[]> => {
  const ranges: IBackupRange[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: BACKUP_RANGE_TABLE,
        KeyConditionExpression: 'backupJobId = :j AND begins_with(rangeKey, :p)',
        ExpressionAttributeValues: { ':j': backupJobId, ':p': `${objectKey}#r` },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );
    ranges.push(...((result.Items ?? []) as IBackupRange[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return ranges;
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const batchWrite = async (
  requests: Array<{ PutRequest: { Item: any } } | { DeleteRequest: { Key: any } }>
): Promise<void> => {
  for (let i = 0; i < requests.length; i += BATCH_WRITE_LIMIT) {
    let pending: typeof requests = requests.slice(i, i + BATCH_WRITE_LIMIT);
    for (let attempt = 0; pending.length && attempt < 5; attempt++) {
      const result = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [BACKUP_RANGE_TABLE]: pending } })
      );
      pending = (result.UnprocessedItems?.[BACKUP_RANGE_TABLE] ?? []) as typeof requests;
      if (pending.length) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (pending.length) {
      throw new Error(`[range] could not write ${pending.length} range item(s) after retries`);
    }
  }
};

export const deleteObjectRanges = async (backupJobId: string, objectKey: string): Promise<void> => {
  const ranges = await listRanges(backupJobId, objectKey);
  const keys = [...ranges.map((r) => r.rangeKey), planRangeKey(objectKey)];
  await batchWrite(keys.map((rangeKey) => ({ DeleteRequest: { Key: { backupJobId, rangeKey } } })));
};

export const putPlanAndRanges = async (
  plan: IBackupRangePlan,
  ranges: IBackupRange[]
): Promise<void> => {
  await batchWrite([plan, ...ranges].map((Item) => ({ PutRequest: { Item } })));
};

interface IUpdateRangeParams {
  backupJobId: string;
  rangeKey: string;
  set?: Partial<Omit<IBackupRange, 'backupJobId' | 'rangeKey' | 'updatedAt'>>;
  remove?: Array<keyof IBackupRange>;
  add?: Partial<Record<'waitTimeouts' | 'salesforceApiCount' | 'verifyFailures', number>>;
}

// Conditional update that never touches a DONE or SPLIT range, so a task that was
// replaced (restart, scale-in) cannot overwrite finished work. Returns false when
// the range is missing or already terminal.
export const updateRange = async (params: IUpdateRangeParams): Promise<boolean> => {
  const { backupJobId, rangeKey, set = {}, remove = [], add = {} } = params;
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = {
    ':updatedAt': new Date().toISOString(),
    ':done': JOB_OBJECT_STATUS.uploadCompleted,
    ':split': JOB_OBJECT_STATUS.split,
  };
  const setParts = ['updatedAt = :updatedAt'];

  Object.entries(set).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    names[`#s_${key}`] = key;
    values[`:s_${key}`] = value;
    setParts.push(`#s_${key} = :s_${key}`);
  });

  const addParts: string[] = [];
  Object.entries(add).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    names[`#a_${key}`] = key;
    values[`:a_${key}`] = value;
    addParts.push(`#a_${key} :a_${key}`);
  });

  const removeParts = remove.map((key) => {
    names[`#r_${String(key)}`] = String(key);
    return `#r_${String(key)}`;
  });

  const expression = [
    `SET ${setParts.join(', ')}`,
    ...(addParts.length ? [`ADD ${addParts.join(', ')}`] : []),
    ...(removeParts.length ? [`REMOVE ${removeParts.join(', ')}`] : []),
  ].join(' ');

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_RANGE_TABLE,
        Key: { backupJobId, rangeKey },
        UpdateExpression: expression,
        ConditionExpression: 'attribute_exists(rangeKey) AND NOT (#status IN (:done, :split))',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
};

// Atomically replaces `parent` by `leaves`: parent -> SPLIT and every leaf created
// in one transaction, so a crash can never leave a half-split range.
export const splitRange = async (
  backupJobId: string,
  parent: IBackupRange,
  leaves: IBackupRange[]
): Promise<void> => {
  if (leaves.length + 1 > TRANSACT_LIMIT) {
    throw new Error(`[range] cannot split ${parent.rangeId} into ${leaves.length} ranges at once`);
  }
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: BACKUP_RANGE_TABLE,
            Key: { backupJobId, rangeKey: parent.rangeKey },
            UpdateExpression: 'SET #status = :split, updatedAt = :now',
            ConditionExpression: 'attribute_exists(rangeKey) AND NOT (#status IN (:done, :split))',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':split': JOB_OBJECT_STATUS.split,
              ':done': JOB_OBJECT_STATUS.uploadCompleted,
              ':now': new Date().toISOString(),
            },
          },
        },
        ...leaves.map((leaf) => ({
          Put: {
            TableName: BACKUP_RANGE_TABLE,
            Item: leaf,
            ConditionExpression: 'attribute_not_exists(rangeKey)',
          },
        })),
      ],
    })
  );
};

// Counts a size-related failed Salesforce job for the object and returns the new total.
export const incrementFailedJobs = async (
  backupJobId: string,
  objectKey: string
): Promise<number> => {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: BACKUP_RANGE_TABLE,
      Key: { backupJobId, rangeKey: planRangeKey(objectKey) },
      UpdateExpression: 'ADD failedJobs :one SET updatedAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return Number(result.Attributes?.failedJobs ?? 0);
};

// safeRangeSize only ever decreases: later failures can only make ranges smaller.
export const lowerSafeRangeSize = async (
  backupJobId: string,
  objectKey: string,
  size: number
): Promise<void> => {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: BACKUP_RANGE_TABLE,
        Key: { backupJobId, rangeKey: planRangeKey(objectKey) },
        UpdateExpression: 'SET safeRangeSize = :size, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(safeRangeSize) OR safeRangeSize > :size',
        ExpressionAttributeValues: { ':size': size, ':now': new Date().toISOString() },
      })
    );
  } catch (err: any) {
    if (err.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }
};

export const isTerminalRange = (range: IBackupRange): boolean => TERMINAL.includes(range.status);
