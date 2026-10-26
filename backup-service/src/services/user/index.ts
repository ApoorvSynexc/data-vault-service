import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { USER_TABLE } from '../../constant';
import { IUser } from '../../models';

// Read-only by design — client-service owns USER_TABLE and every write path
// to it. This exists only so job-outcome notifications/emails
// (services/third-party/salesforce) can resolve a userId to an email
// address without a cross-service HTTP round trip, same as how
// BACKUP_CONFIG_TABLE/RESTORE_TABLE are already read directly by both services.
const getUser = async (userId: string): Promise<IUser | null> => {
  const result = await docClient.send(new GetCommand({ TableName: USER_TABLE, Key: { userId } }));
  return (result.Item as IUser) ?? null;
};

export { getUser };
