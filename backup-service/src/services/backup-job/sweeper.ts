import { OBJECT_STATUS, JOB_STATUS } from '../../constant';
import { logger } from '../../middlewares/logger';
import { IBackupJob } from '../../models';
import { getStaleRunningJobs, updateBackupObject, updateJobStatus } from './index';

const STALE_THRESHOLD_MINUTES = 15;
const SWEEP_INTERVAL_MS = 1 * 60 * 1000; // 5 minutes

const STUCK_STATUSES = new Set([
  OBJECT_STATUS.transferInProgress,
  OBJECT_STATUS.bulkQueryInProgress,
]);

const processStaleJobPage = async (jobs: IBackupJob[]): Promise<void> => {
  logger.warn(`Stale job sweeper: processing ${jobs.length} stale job(s)`);

  for (const job of jobs) {
    // Mark each stuck object as FAILED so resume can identify them
    if (job.object?.length) {
      await Promise.allSettled(
        job.object
          .map((obj, idx) => ({ obj, idx }))
          .filter(({ obj }) => obj.status !== undefined && STUCK_STATUSES.has(obj.status))
          .map(({ idx }) =>
            updateBackupObject({
              backupJobId: job.backupJobId,
              objectIndex: idx,
              status: OBJECT_STATUS.failed,
              errorMessage: 'Marked stale — server crash or restart detected',
            })
          )
      );
    }

    await updateJobStatus({
      backupJobId: job.backupJobId,
      status: JOB_STATUS.failed,
      completedAt: new Date().toISOString(),
      errorMessage: 'Job became stale — server crash or restart detected',
    });

    logger.warn(`Stale job sweeper: marked job ${job.backupJobId} as FAILED`);
  }
};

const sweepStaleJobs = async (): Promise<void> => {
  try {
    await getStaleRunningJobs(STALE_THRESHOLD_MINUTES, processStaleJobPage);
  } catch (err: any) {
    logger.error(`Stale job sweeper error: ${err?.message}`);
  }
};

export const startStaleJobSweeper = (): void => {
  logger.info(
    `Stale job sweeper started (threshold: ${STALE_THRESHOLD_MINUTES}min, interval: ${SWEEP_INTERVAL_MS / 60_000}min)`
  );
  setInterval(sweepStaleJobs, SWEEP_INTERVAL_MS);
};
