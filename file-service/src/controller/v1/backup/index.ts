import { Request, Response } from 'express';
import { getBackupConfig, getBackupJob } from '../../../services';
import { IBackupConfig, IDestinationConfig, ISource } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { buildS3KeyPrefix } from '../../../utils/helper';

const getBackupHandler = async (req: Request, res: Response): Promise<void> => {
  const { backupJobIds } = req.body as { backupJobIds: string[] };

  const payload = []

  let backupConfig: IBackupConfig | null = null;
  for (let index = 0; index < backupJobIds.length; index++) {
    const backupJobId = backupJobIds[index];
    const job = await getBackupJob(backupJobId);
    if (!job || !job.object) continue;

    if (!backupConfig) {
      backupConfig = await getBackupConfig(job.backupConfigId);
      if (!backupConfig) continue;
    }

    const destination = JSON.parse(decrypt(job.destination)) as IDestinationConfig;
    const source = JSON.parse(decrypt(job.source)) as ISource;

    for (let index = 0; index < job.object.length; index++) {
      const object = job.object[index];
      const prefix = buildS3KeyPrefix({
        crmId: source.crmId,
        crmName: source.crmName,
        backupConfigId: backupConfig.backupConfigId,
        backupJobId,
        objectName: object.name,
        type: 'backup',
        operation: 'inserts',
      });

      payload.push({
        prefix
      });
    }
  }

  res.status(200).send({
    success: true,
    message: 'fetch',
    data: payload,
    meta: {},
  });
};

export const backupController = { getBackupHandler };
