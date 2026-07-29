import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { RESTORE_TABLE } from '../../constant';
import {
  IRestore,
  IRestoreConflict,
  IRestoreDestination,
  IRestoreJobDetail,
  IRestoreScope,
  IRestoreSource,
  IScheduleConfig,
} from '../../models';
import { decodeCursor, encodeCursor } from '../../utils/cursor';

interface CreateRestoreParams {
  restoreId?: string;
  userId: string;
  crmId?: string;
  status?: string;
  source: IRestoreSource;
  selection: {
    restoreScope: IRestoreScope;
  };
  destination: IRestoreDestination;
  conflict: IRestoreConflict;
  restoreType?: string;
  jobDetail: IRestoreJobDetail;
  schedule: IScheduleConfig;
}

const createRestore = async (params: CreateRestoreParams): Promise<IRestore> => {
  const {
    restoreId,
    userId,
    crmId,
    status = 'PENDING',
    source,
    selection,
    destination,
    conflict,
    restoreType = 'RESTORE_ONLY_CHANGED_FIELDS',
    jobDetail,
    schedule,
  } = params;
  const now = new Date().toISOString();

  const item: IRestore = {
    restoreId: restoreId ?? uuidv4(),
    userId,
    ...(crmId && { crmId }),
    status,
    source,
    selection,
    destination,
    conflict,
    restoreType,
    jobDetail,
    schedule,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: RESTORE_TABLE, Item: item }));
  return item;
};

const getRestoreById = async (restoreId: string): Promise<IRestore | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: RESTORE_TABLE,
      Key: { restoreId },
    })
  );
  return (result.Item as IRestore) ?? null;
};

const getRestoresByUserId = async (userId: string): Promise<IRestore[]> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESTORE_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    })
  );
  return (result.Items as IRestore[] | undefined) ?? [];
};

const getRestoresWithPagination = async (
  filter: {
    userId?: string;
    crmId?: string;
    status?: string;
    search?: string;
    createdAtFrom?: string;
    createdAtTo?: string;
  },
  pagination?: { limit?: number; cursor?: string }
): Promise<{ documents: IRestore[]; nextCursor: string | null }> => {
  const { userId, crmId, status, search, createdAtFrom, createdAtTo } = filter;
  const { limit = 10, cursor } = pagination || {};
  const exclusiveStartKey = decodeCursor(cursor);

  if (!userId && !crmId) {
    throw new Error('Either userId or crmId must be provided');
  }

  // userId-index is preferred whenever userId is available, else crmId-index.
  // createdAt is the sort key on both, so a date-range filter goes straight into
  // the KeyConditionExpression instead of a slower FilterExpression scan.
  const useUserIdKey = !!userId;
  const indexName = useUserIdKey ? 'userId-index' : 'crmId-index';
  const keyAttribute = useUserIdKey ? 'userId' : 'crmId';
  const keyValue = useUserIdKey ? userId : crmId;
  const isSearch = !!search && search.length > 0;

  const expressionAttributeNames: Record<string, string> = {
    ...(status && { '#status': 'status' }),
  };

  // Treats the search term as a case-insensitive regex (falls back to an escaped
  // literal match if it isn't valid regex syntax) tested against jobDetail.name
  // OR jobDetail.description. DynamoDB's contains() is case-sensitive and can't
  // reach into a nested attribute this way, so matching happens client-side.
  let searchPattern: RegExp | null = null;
  if (isSearch) {
    try {
      searchPattern = new RegExp(search!, 'i');
    } catch {
      searchPattern = new RegExp(search!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }

  const buildStatusFilter = (expressionAttributeValues: Record<string, any>): string[] => {
    const expressions: string[] = [];
    if (status) {
      expressionAttributeValues[':status'] = status;
      expressions.push('#status = :status');
    }
    return expressions;
  };

  // DynamoDB's Limit bounds items read per request, not items matched by
  // FilterExpression/postFilter, so a single page can under-fill once a filter is
  // applied. Keep paging with ExclusiveStartKey until `limit` filtered documents
  // are collected or the table is exhausted, capping each request's Limit to the
  // remaining need so results never overshoot the page boundary reported back via
  // nextCursor.
  const collectPage = async (
    sendPage: (pageLimit: number, startKey?: Record<string, any>) => Promise<{ Items?: any[]; LastEvaluatedKey?: Record<string, any> }>,
    postFilter?: (document: IRestore) => boolean
  ): Promise<{ documents: IRestore[]; nextCursor: string | null }> => {
    const documents: IRestore[] = [];
    let startKey = exclusiveStartKey;
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const pageResult = await sendPage(limit - documents.length, startKey);
      const items = (pageResult.Items as IRestore[] | undefined) ?? [];
      documents.push(...(postFilter ? items.filter(postFilter) : items));
      lastEvaluatedKey = pageResult.LastEvaluatedKey;
      startKey = lastEvaluatedKey;
    } while (documents.length < limit && lastEvaluatedKey);

    return {
      documents,
      nextCursor: lastEvaluatedKey ? encodeCursor(lastEvaluatedKey) : null,
    };
  };

  if (isSearch) {
    // Scan has no key condition, so the identity attribute and date range (when
    // present) are added as plain equality/comparison filters instead.
    const expressionAttributeValues: Record<string, any> = {};
    const filterExpressions = buildStatusFilter(expressionAttributeValues);

    if (useUserIdKey) {
      expressionAttributeValues[':userId'] = userId;
      filterExpressions.push('userId = :userId');
    } else {
      expressionAttributeValues[':crmId'] = crmId;
      filterExpressions.push('crmId = :crmId');
    }
    if (createdAtFrom) {
      expressionAttributeValues[':createdAtFrom'] = createdAtFrom;
      filterExpressions.push('createdAt >= :createdAtFrom');
    }
    if (createdAtTo) {
      expressionAttributeValues[':createdAtTo'] = createdAtTo;
      filterExpressions.push('createdAt <= :createdAtTo');
    }

    return collectPage(
      (pageLimit, startKey) =>
        docClient.send(
          new ScanCommand({
            TableName: RESTORE_TABLE,
            ...(Object.keys(expressionAttributeNames).length > 0 && { ExpressionAttributeNames: expressionAttributeNames }),
            ExpressionAttributeValues: expressionAttributeValues,
            ...(filterExpressions.length > 0 && { FilterExpression: filterExpressions.join(' AND ') }),
            Limit: pageLimit,
            ...(startKey && { ExclusiveStartKey: startKey }),
          })
        ),
      (document) =>
        !!searchPattern &&
        ((!!document.jobDetail?.name && searchPattern.test(document.jobDetail.name)) ||
          (!!document.jobDetail?.description && searchPattern.test(document.jobDetail.description)))
    );
  }

  const expressionAttributeValues: Record<string, any> = { ':key': keyValue };
  const filterExpressions = buildStatusFilter(expressionAttributeValues);

  let keyConditionExpression = `${keyAttribute} = :key`;
  if (createdAtFrom && createdAtTo) {
    keyConditionExpression += ' AND createdAt BETWEEN :createdAtFrom AND :createdAtTo';
    expressionAttributeValues[':createdAtFrom'] = createdAtFrom;
    expressionAttributeValues[':createdAtTo'] = createdAtTo;
  } else if (createdAtFrom) {
    keyConditionExpression += ' AND createdAt >= :createdAtFrom';
    expressionAttributeValues[':createdAtFrom'] = createdAtFrom;
  } else if (createdAtTo) {
    keyConditionExpression += ' AND createdAt <= :createdAtTo';
    expressionAttributeValues[':createdAtTo'] = createdAtTo;
  }

  return collectPage((pageLimit, startKey) =>
    docClient.send(
      new QueryCommand({
        TableName: RESTORE_TABLE,
        IndexName: indexName,
        KeyConditionExpression: keyConditionExpression,
        ...(Object.keys(expressionAttributeNames).length > 0 && { ExpressionAttributeNames: expressionAttributeNames }),
        ExpressionAttributeValues: expressionAttributeValues,
        ...(filterExpressions.length > 0 && { FilterExpression: filterExpressions.join(' AND ') }),
        Limit: pageLimit,
        ...(startKey && { ExclusiveStartKey: startKey }),
      })
    )
  );
};

export { createRestore, getRestoreById, getRestoresByUserId, getRestoresWithPagination };
