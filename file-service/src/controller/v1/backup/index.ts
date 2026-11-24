import { Request, Response } from 'express';
import { getBackupConfig, getBackupJob, getCrmHandler } from '../../../services';
import { makeResponse } from '../../../lib/response';
import { IBackupConfig, IDestinationConfig, ISource } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { wrapController } from '../../../utils/helper';

const getBackupHandler = async (req: Request, res: Response): Promise<void> => {
  const { backupJobIds } = req.body as { backupJobIds: string[] };

  let backupConfig: IBackupConfig | null = null;
  for (const backupJobId of backupJobIds) {
    const job = await getBackupJob(backupJobId);
    if (!job || !job.object) continue;

    if (!backupConfig) {
      backupConfig = await getBackupConfig(job.backupConfigId);
      if (!backupConfig) continue;
    }

    const destination = JSON.parse(decrypt(job.destination)) as IDestinationConfig;
    const source = JSON.parse(decrypt(job.source)) as ISource;

    await getCrmHandler(source.crmName).backupFiles({
      job,
      backupConfig,
      source,
      destination,
    });
  }

  makeResponse(req, res, 200, true, 'fetch');
};

export const backupController = wrapController({ getBackupHandler });
