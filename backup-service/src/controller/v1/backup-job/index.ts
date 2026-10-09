import { IRequest, IResponse, makeResponse } from '../../../lib';
import { createBackupJob, createArchivalJob } from '../../../services';
import { resumeBackupJob, runBackupJob, runArchivalJob } from '../../../services/common/runner';
import { wrapController } from '../../../utils/helper';

const createBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { triggerSource, lastUpdatedAt } = req.body;
  const modifiedSince = lastUpdatedAt ? new Date(lastUpdatedAt) : undefined;
  const modifiedUntil = new Date();
  const job = await createBackupJob({ ...req.body, modifiedSince, modifiedUntil });

  // Respond immediately — backup runs in the background
  makeResponse(req, res, 201, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
    modifiedSince,
    modifiedUntil,
  });

  // Fire-and-forget: errors are caught inside runBackupJob and persisted to DynamoDB
  runBackupJob({ ...job, triggerSource }).catch(() => { });
};

const resumeBackupJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { id: backupJobId } = req.query as { id: string };
  const job = await resumeBackupJob(backupJobId);

  if (!job) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'job_resume', { backupJobId, status: job.status });
  runBackupJob(job).catch(() => { });
};

const createArchivalJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { lastUpdatedAt } = req.body;
  const modifiedSince = lastUpdatedAt ? new Date(lastUpdatedAt) : undefined;
  const modifiedUntil = new Date();
  const job = await createArchivalJob({ ...req.body, modifiedSince, modifiedUntil });

  // Respond immediately — archival runs in the background
  makeResponse(req, res, 201, true, 'create', {
    backupJobId: job.backupJobId,
    status: job.status,
    modifiedSince,
    modifiedUntil,
  });

  // Fire-and-forget: errors are caught inside runArchivalJob and persisted to DynamoDB
  runArchivalJob(job).catch(() => { });
};

const resumeArchivalJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { id: backupJobId } = req.query as { id: string };
  const job = await resumeBackupJob(backupJobId);
  if (!job) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'job_resume', { backupJobId, status: job.status });
  runArchivalJob(job).catch(() => { });
};

export const backupJobController = wrapController({
  createBackupJobHandler,
  resumeBackupJobHandler,
  createArchivalJobHandler,
  resumeArchivalJobHandler,
});
