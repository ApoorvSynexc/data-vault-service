import { Request, Response } from 'express';
import { getBackupJob } from '../../../services';

const getBackupHandler = async (req: Request, res: Response): Promise<void> => {
  const { backupJobIds } = req.body as { backupJobIds: string[] };

  const jobs = await Promise.all(backupJobIds.map((backupJobId) => getBackupJob(backupJobId)));

  res.status(200).send({
    success: true,
    message: 'fetch',
    data: jobs,
    meta: {},
  });
};

export const backupController = { getBackupHandler };
