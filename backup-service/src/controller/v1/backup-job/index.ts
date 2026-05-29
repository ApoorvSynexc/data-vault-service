import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createBackupJob } from '../../../services';
import { resumeBackupJob, runBackupJob } from '../../../services/common/runner';
import { JOB_STATUS } from '../../../constant';
import { wrapController } from '../../../utils/helper';

const createBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const job = await createBackupJob(req.body);

  // Respond immediately — backup runs in the background
  makeResponse(req, res, 202, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
  });

  // Fire-and-forget: errors are caught inside runBackupJob and persisted to DynamoDB
  runBackupJob(job).catch(() => {});
};

const resumeBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { id: backupJobId } = req.query as { id: string };
  const job = await resumeBackupJob(backupJobId);
  makeResponse(req, res, 202, true, 'job_resume', { backupJobId, status: JOB_STATUS.running });
  runBackupJob(job).catch(() => {});
};

export const backupJobController = wrapController({
  createBackupJobHandler,
  resumeBackupJobHandler,
});
