import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { OAUTH_STATE_TABLE } from '../../constant';
import { IOAuthState } from '../../models';

const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes

const createOAuthState = async (
  state: string,
  codeVerifier: string,
  userId: string,
  crmName: string,
  environment?: 'production' | 'sandbox' | 'custom',
  customUrl?: string,
  name?: string,
  isAdminUser?: boolean,
  adminUserSfProfile?: IOAuthState['adminUserSfProfile']
): Promise<void> => {
  const item: IOAuthState = {
    state,
    codeVerifier,
    userId,
    crmName,
    environment,
    customUrl,
    name,
    isAdminUser,
    adminUserSfProfile,
    ttl: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
    createdAt: new Date().toISOString(),
  };

  await docClient.send(new PutCommand({ TableName: OAUTH_STATE_TABLE, Item: item }));
};

const getOAuthState = async (state: string): Promise<IOAuthState | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: OAUTH_STATE_TABLE, Key: { state } })
  );
  return (result.Item as IOAuthState) ?? null;
};

export { createOAuthState, getOAuthState };
