import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { RESTORE_TABLE } from '../../constant';
import {
  IRestore,
  IRestoreConflict,
  IRestoreDestination,
  IRestoreJobDetail,
  IRestoreScope,
  IScheduleConfig,
} from '../../models';

interface CreateRestoreParams {
  restoreId?: string;
  userId: string;
  crmId?: string;
  status?: string;
  source: {
    backupJobIds: string[];
  };
  selection: {
    restoreScope: IRestoreScope;
  };
  destination: IRestoreDestination;
  conflict: IRestoreConflict;
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

export { createRestore, getRestoreById, getRestoresByUserId };
