import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { BACKUP_CONFIG_TABLE } from '../../constant';
import { IBackupConfig } from '../../models';

const getBackupConfig = async (backupConfigId: string): Promise<IBackupConfig | null> => {
  const result = await docClient.send(
    new GetCommand({ TableName: BACKUP_CONFIG_TABLE, Key: { backupConfigId } })
  );
  return (result.Item as IBackupConfig) ?? null;
};

export { getBackupConfig };
