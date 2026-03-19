import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { SESSION_STATUS, SESSION_TABLE } from '../../constant';
import { ISession, ISessionDeviceInfo } from '../../models';

// ---------------------------------------------------------------------------
// DynamoDB table layout
//   PK:  sessionId
//   GSI: user-sessions-index  PK = userId
//   TTL: ttl  (Unix epoch seconds)
// ---------------------------------------------------------------------------

const createSession = async (
  userId: string,
  ttlSeconds: number,
  deviceInfo?: ISessionDeviceInfo
): Promise<ISession> => {
  const now = new Date().toISOString();
  const session: ISession = {
    sessionId: uuidv4(),
    userId,
    status: SESSION_STATUS.active,
    deviceInfo,
    ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: SESSION_TABLE, Item: session }));
  return session;
};

const getSession = async (sessionId: string): Promise<ISession | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: SESSION_TABLE, Key: { sessionId } })
  );
  return (result.Item as ISession) ?? null;
};

const updateSession = async (sessionId: string, payload: Partial<ISession>): Promise<void> => {
  const now = new Date().toISOString();
  const $set = { ...payload, updatedAt: now };

  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  const parts: string[] = [];

  Object.entries($set).forEach(([key, val], i) => {
    if (key === 'sessionId') {
      return;
    }
    names[`#f${i}`] = key;
    values[`:v${i}`] = val;
    parts.push(`#f${i} = :v${i}`);
  });

  if (!parts.length) {
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { sessionId },
      UpdateExpression: `SET ${parts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
};

export { createSession, getSession, updateSession };
