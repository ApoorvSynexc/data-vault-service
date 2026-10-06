import { ERROR_REASON, JOB_OBJECT_STATUS } from "../constant";
import { logger } from "../middlewares";
import { getStaleJobs, updateBackupJob } from "../services";
const STALE_THRESHOLD_MINUTES = 360;  // 6 hours


const staleObjectSweeperJob = async (): Promise<void> => {
    let totalJobs = 0;
    let successJobs = 0;

    try {
        await getStaleJobs(
            STALE_THRESHOLD_MINUTES,
            100,
            async (jobs) => {
                for (let index = 0; index < jobs.length; index++) {
                    const job = jobs[index];
                    totalJobs++;

                    const objects = job.object?.map((obj) => {
                        const lastStatus = obj.status;
                        if([JOB_OBJECT_STATUS.deletionCompleted, JOB_OBJECT_STATUS.uploadCompleted, JOB_OBJECT_STATUS.restoreCompleted].includes(obj.status || '')) {
                            return obj
                        } else {
                            return {
                                ...obj,
                                status: JOB_OBJECT_STATUS.failed,
                                errorMessage: `It is failed when it was ${lastStatus} status`
                            }
                        }
                    });

                    if (objects?.length) {
                        await updateBackupJob(
                            {
                            backupJobId: job.backupJobId,
                            object: objects,
                            status: JOB_OBJECT_STATUS.failed,
                            errorReason: ERROR_REASON.serverCrashed,
                            errorMessage: 'Job became stale — server crash or restart detected',
                            completedAt: new Date().toISOString(),
                        });
                        successJobs++;
                    }
                }
            }
        );

        logger.info(`[Stale Job sweep - CRON] ${successJobs}/${totalJobs} synced successfully`);
    } catch (error) {
        logger.error(`[Stale Job sweep - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    }
};

export {
    staleObjectSweeperJob
}