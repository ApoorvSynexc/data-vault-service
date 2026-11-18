import { Request, Response } from 'express';
import { getBackupJob } from '../../../services';
import { IDestinationConfig } from '../../../models';
import { decrypt } from '../../../utils/encryption';

const getBackupHandler = async (req: Request, res: Response): Promise<void> => {
  const { backupJobIds } = req.body as { backupJobIds: string[] };

  const jobs = await Promise.all(backupJobIds.map((backupJobId) => getBackupJob(backupJobId)));

  const destinations = jobs.map((job) =>
    job ? (JSON.parse(decrypt(job.destination)) as IDestinationConfig) : null
  );

  console.log({ destinations });

  res.status(200).send({
    success: true,
    message: 'fetch',
    data: jobs,
    meta: {},
  });
};

export const backupController = { getBackupHandler };
