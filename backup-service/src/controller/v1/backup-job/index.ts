import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createBackupJob } from '../../../services';
import { resumeBackupJob, runBackupJob, runArchivalJob } from '../../../services/common/runner';
import { JOB_STATUS } from '../../../constant';
import { wrapController } from '../../../utils/helper';

const createBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const job = await createBackupJob(req.body);

  // Respond immediately — backup runs in the background
  makeResponse(req, res, 201, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
  });

  // Fire-and-forget: errors are caught inside runBackupJob and persisted to DynamoDB
  runBackupJob(job).catch(() => {});
};

const resumeBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { id: backupJobId } = req.query as { id: string };
  const job = await resumeBackupJob(backupJobId);

  if(!job) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'job_resume', { backupJobId, status: JOB_STATUS.running });
  runBackupJob(job).catch(() => {});
};

const createArchivalJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const job = await createBackupJob(req.body);

  // Respond immediately — archival runs in the background
  makeResponse(req, res, 201, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
  });

  // Fire-and-forget: errors are caught inside runArchivalJob and persisted to DynamoDB
  runArchivalJob(job).catch(() => {});
};

const resumeArchivalJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { id: backupJobId } = req.query as { id: string };
  const job = await resumeBackupJob(backupJobId);
  if(!job) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'job_resume', { backupJobId, status: JOB_STATUS.running });
  runArchivalJob(job).catch(() => {});
};

export const backupJobController = wrapController({
  createBackupJobHandler,
  resumeBackupJobHandler,
  createArchivalJobHandler,
  resumeArchivalJobHandler,
});
