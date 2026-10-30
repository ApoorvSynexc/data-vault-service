import crypto from 'crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { TOKEN_EVENT_TABLE } from '../../constant';
import { ITokenEvent } from '../../models';
import { logger } from '../../middlewares/logger';

const TOKEN_EVENT_RETENTION_DAYS = 180;
const TOKEN_EVENT_SOURCE = `client-service#pid-${process.pid}`;

type TokenEventInput = Omit<
  ITokenEvent,
  'eventKey' | 'eventId' | 'eventAt' | 'source' | 'expiresAt'
>;

// 16-hex SHA-256 prefix — enough to tell two tokens apart in logs and CAS
// conditions without ever persisting the token itself.
const fingerprintToken = (token?: string | null): string | undefined =>
  token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : undefined;

const buildTokenEvent = (input: TokenEventInput): ITokenEvent => {
  const eventAt = new Date().toISOString();
  const eventId = uuidv4();
  // DynamoDB rejects undefined attributes and empty strings in GSI keys.
  const defined = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== '')
  ) as TokenEventInput;
  return {
    ...defined,
    eventId,
    eventAt,
    eventKey: `${eventAt}#${eventId}`,
    source: TOKEN_EVENT_SOURCE,
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_EVENT_RETENTION_DAYS * 24 * 60 * 60,
  };
};

const putTokenEvent = (event: ITokenEvent) =>
  docClient.send(new PutCommand({ TableName: TOKEN_EVENT_TABLE, Item: event }));

// Synchronous write — only for REFRESH_ATTEMPT, whose presence without an
// outcome is how the classifier detects a rotation lost to a crash. Still
// never throws: a logging outage must not block a refresh. Returns the row's
// eventKey (also when the write failed — it is just a sort position).
const recordTokenEvent = async (input: TokenEventInput): Promise<string> => {
  const event = buildTokenEvent(input);
  try {
    await putTokenEvent(event);
  } catch (error) {
    logger.error(
      `[token-event] failed to write ${event.eventType} for user ${event.userId}: ${(error as Error)?.message}`
    );
  }
  return event.eventKey;
};

// Fire-and-forget with one retry — every other event type.
const logTokenEvent = (input: TokenEventInput): void => {
  const event = buildTokenEvent(input);
  putTokenEvent(event)
    .catch(() => putTokenEvent(event))
    .catch((error) => {
      logger.error(
        `[token-event] failed to write ${event.eventType} for user ${event.userId}: ${(error as Error)?.message}`
      );
    });
};

const LATEST_EVENT_MAX_PAGES = 5;

// Latest event of the given types for a user, optionally only among events
// sorted before `beforeKey`. Pages through results: DynamoDB applies Limit
// before the filter, so a single page of other event types (e.g. a burst of
// LOCK_JOINED) must not hide the match.
const getLatestTokenEvent = async (
  userId: string,
  eventTypes: string[],
  beforeKey?: string
): Promise<ITokenEvent | null> => {
  let lastKey: Record<string, any> | undefined;
  for (let page = 0; page < LATEST_EVENT_MAX_PAGES; page++) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TOKEN_EVENT_TABLE,
        KeyConditionExpression: beforeKey
          ? 'userId = :userId AND eventKey < :beforeKey'
          : 'userId = :userId',
        FilterExpression: `eventType IN (${eventTypes.map((_, i) => `:t${i}`).join(', ')})`,
        ExpressionAttributeValues: {
          ':userId': userId,
          ...(beforeKey && { ':beforeKey': beforeKey }),
          ...Object.fromEntries(eventTypes.map((type, i) => [`:t${i}`, type])),
        },
        ScanIndexForward: false,
        Limit: 50,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
    );
    if (result.Items?.length) {
      return result.Items[0] as ITokenEvent;
    }
    lastKey = result.LastEvaluatedKey as Record<string, any> | undefined;
    if (!lastKey) {
      return null;
    }
  }
  return null;
};

// A user's events since `since`, newest first (support / settings view).
const listTokenEventsByUser = async (
  userId: string,
  since: string,
  limit = 100
): Promise<ITokenEvent[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TOKEN_EVENT_TABLE,
      KeyConditionExpression: 'userId = :userId AND eventKey >= :since',
      ExpressionAttributeValues: { ':userId': userId, ':since': since },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (result.Items as ITokenEvent[]) ?? [];
};

// Every user's events for one org since `since`, newest first (admin view).
const listTokenEventsByCrm = async (
  crmId: string,
  since: string,
  limit = 200
): Promise<ITokenEvent[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TOKEN_EVENT_TABLE,
      IndexName: 'crmId-index',
      KeyConditionExpression: 'crmId = :crmId AND eventAt >= :since',
      ExpressionAttributeValues: { ':crmId': crmId, ':since': since },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (result.Items as ITokenEvent[]) ?? [];
};

export {
  fingerprintToken,
  recordTokenEvent,
  logTokenEvent,
  getLatestTokenEvent,
  listTokenEventsByUser,
  listTokenEventsByCrm,
};
export type { TokenEventInput };
