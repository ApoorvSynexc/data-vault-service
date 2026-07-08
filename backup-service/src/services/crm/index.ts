import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { CRM_TABLE } from '../../constant';

// Backup-service reads CRM records only to resolve the per-org encryption
// key used in the two-layer Salesforce decrypt scheme. This is a read-only,
// intentionally-thin projection of client-service's fuller CRM model; adding
// more fields here should stay defensive — writes to CRM_TABLE happen in
// client-service, not here.
export interface ICrm {
  crmId: string;
  organizationId: string;
  crmName?: string;
  encryptionKey?: string;
  instanceUrl?: string;
  environment?: string;
}

// Uses the same GSI (organizationId-index) that client-service defines on the
// shared data-vault-crms table.
export const getCrmByOrgId = async (orgId: string): Promise<ICrm | null> => {
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
