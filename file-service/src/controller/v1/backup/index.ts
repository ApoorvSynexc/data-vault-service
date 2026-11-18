import { Request, Response } from 'express';
import { getBackupJob } from '../../../services/backup-job';

const getBackupJobHandler = async (req: Request, res: Response): Promise<void> => {
  const { id: backupJobId } = req.query as { id: string };

  if (!backupJobId) {
    res.status(400).send({ success: false, message: 'id is required', data: null, meta: {} });
    return;
  }

  const job = await getBackupJob(backupJobId);

  if (!job) {
    res.status(404).send({ success: false, message: 'not_exist', data: null, meta: {} });
    return;
  }

  res.status(200).send({ success: true, message: 'fetch', data: job, meta: {} });
};

export const backupJobController = { getBackupJobHandler };
