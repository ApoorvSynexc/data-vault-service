import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { CRM_TABLE, STATUS } from '../../constant';
import { ICrm } from '../../models';

interface UpsertCrmParams {
  crmId?: string;
  userId?: string;
  crmName: string;
  organizationId: string;
  environment?: 'production' | 'sandbox';
  name?: string;
  status?: string;
  instanceUrl?: string;
  encryptionKey?: string | { ciphertext: string; iv: string };
}

const upsertCrm = async (params: UpsertCrmParams): Promise<ICrm> => {
  const {
    crmId,
    userId,
    crmName,
    organizationId,
    environment,
    name,
    status,
    instanceUrl,
    encryptionKey,
  } = params;

  const id = crmId ?? uuidv4();
  const now = new Date().toISOString();

  // Get existing item (if any)
  const existingCrm = await getCrmById(id);

  const crm: ICrm = {
    ...existingCrm,

    crmId: id,
    organizationId,
    crmName,

    environment: environment ?? existingCrm?.environment ?? 'production',
    status: status ?? existingCrm?.status ?? STATUS.active,

    ...(name !== undefined && { name }),
    ...(userId !== undefined && { userId }),
    ...(instanceUrl !== undefined && { instanceUrl }),
    ...(encryptionKey !== undefined && { encryptionKey }),

    createdAt: existingCrm?.createdAt ?? now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: CRM_TABLE,
      Item: crm,
    })
  );

  return crm;
};

const getCrmById = async (crmId: string): Promise<ICrm | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
    })
  );
  return (result.Item as ICrm) ?? null;
};

const deleteCrm = async (crmId: string): Promise<boolean> => {
  const existing = await getCrmById(crmId);
  if (!existing) {
    return false;
  }

  await docClient.send(
    new DeleteCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
    })
  );

  return true;
};

const getCrmByOrgId = async (orgId: string): Promise<ICrm | null> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CRM_TABLE,
      IndexName: 'organizationId-index',
      KeyConditionExpression: 'organizationId = :orgId',
      ExpressionAttributeValues: { ':orgId': orgId },
      Limit: 1,
    })
  );
  return (result.Items?.[0] as ICrm) ?? null;
};

const updateCrm = async (crmId: string, updates: Record<string, any>): Promise<ICrm | null> => {
  const existing = await getCrmById(crmId);
  if (!existing) {
    return null;
  }

  const updatedAt = new Date().toISOString();
  const updateExpressionParts: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': updatedAt,
  };

  let partIndex = 0;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null) {
      const placeholder = `:val${partIndex}`;
      const nameKey = `#attr${partIndex}`;

      expressionAttributeNames[nameKey] = key;
      expressionAttributeValues[placeholder] = value;
      updateExpressionParts.push(`${nameKey} = ${placeholder}`);
      partIndex++;
    }
  }

  if (updateExpressionParts.length === 0) {
    return existing;
  }

  const updateExpression = `SET ${updateExpressionParts.join(', ')}, updatedAt = :updatedAt`;

  await docClient.send(
    new UpdateCommand({
      TableName: CRM_TABLE,
      Key: { crmId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return {
    ...existing,
    ...updates,
    updatedAt,
  };
};

const getCrmsInBatches = async (
  onPage: (crms: ICrm[]) => Promise<void>,
  filters?: { crmName?: string; status?: string },
  limit: number = 100
): Promise<void> => {
  let lastEvaluatedKey: Record<string, any> | undefined;

  const filterExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  if (filters?.crmName) {
    filterExpressions.push('#crmName = :crmName');
    expressionAttributeNames['#crmName'] = 'crmName';
    expressionAttributeValues[':crmName'] = filters.crmName;
  }
  if (filters?.status) {
    filterExpressions.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = filters.status;
  }

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: CRM_TABLE,
        Limit: limit,
        ...(filterExpressions.length && {
          FilterExpression: filterExpressions.join(' AND '),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        }),
        ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
      })
    );

    const crms = (result.Items as ICrm[] | undefined) ?? [];
    if (crms.length) {
      await onPage(crms);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
};

export {
  upsertCrm,
  getCrmById,
  getCrmByOrgId,
  deleteCrm,
  updateCrm,
  getCrmsInBatches,
};
