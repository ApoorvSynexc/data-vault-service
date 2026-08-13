import {
    getBackupConfigsInBatches,
    getBackupJobsByConfig,
    getCrmById,
    getDecryptedDestinationConfig,
    getDestinationById,
} from '../services';
import { uploadToS3 } from '../services/third-party/s3-bucket';
import { logger } from '../middlewares';
import { IBackupConfig, IS3Config } from '../models';

const DEFAULT_KEEP_LATEST_JOBS = 50;
const DEFAULT_CONFIG_BATCH_LIMIT = 100;
const DEFAULT_JOB_PAGE_SIZE = 100;

// getBackupJobsByConfig (services/backup-job) already queries backupConfigId-index
// with ScanIndexForward:false, i.e. newest-first — so "keep the latest N" is just
// "skip the first N jobs seen across pages" and everything after that is archived.
// Uploads the full job record to the config's own S3 destination, one file per
// job; never deletes the DynamoDB row, so this only ever adds an S3 copy.
const archiveJobsForConfig = async (
    config: IBackupConfig,
    keepLatest: number,
    pageSize: number
): Promise<number> => {
    const [crm, destination] = await Promise.all([
        getCrmById(config.crmId),
        getDestinationById(config.destinationId),
    ]);

    if (!crm || !destination) {
        logger.warn(
            `[job-archive - CRON] config ${config.backupConfigId} SKIP | reason=${!crm ? 'crm_not_found' : 'destination_not_found'}`
        );
        return 0;
    }

    const destConfig = getDecryptedDestinationConfig(destination) as IS3Config;
    const type = config.type === 'ARCHIVAL' ? 'archival' : 'backup';

    let seen = 0;
    let archived = 0;
    let cursor: string | undefined;

    do {
        const { items, nextCursor } = await getBackupJobsByConfig(config.backupConfigId, {
            limit: pageSize,
            cursor,
        });

        for (const job of items) {
            seen++;
            if (seen <= keepLatest) {
                continue;
            }

            try {
                const key = `${crm.crmName}/${crm.crmId}/${type}/${config.backupConfigId}/archive-job/${job.backupJobId}.json`;
                await uploadToS3(destConfig, key, Buffer.from(JSON.stringify(job, null, 2)));
                archived++;
            } catch (error: any) {
                logger.error(
                    `[job-archive - CRON] config ${config.backupConfigId} job ${job.backupJobId} failed: ${error?.message ?? error}`
                );
            }
        }

        cursor = nextCursor;
    } while (cursor);

    return archived;
};

const archiveBackupJob = async (
    keepLatest: number = DEFAULT_KEEP_LATEST_JOBS,
    configBatchLimit: number = DEFAULT_CONFIG_BATCH_LIMIT,
    jobPageSize: number = DEFAULT_JOB_PAGE_SIZE
): Promise<void> => {
    const tickStartMs = Date.now();
    logger.info(`[job-archive - CRON] tick START | now=${new Date(tickStartMs).toISOString()}`);

    let configCount = 0;
    let archivedTotal = 0;

    try {
        await getBackupConfigsInBatches(
            async (configs) => {
                configCount += configs.length;
                for (const config of configs) {
                    try {
                        archivedTotal += await archiveJobsForConfig(config, keepLatest, jobPageSize);
                    } catch (error: any) {
                        logger.error(
                            `[job-archive - CRON] config ${config.backupConfigId} threw error: ${error?.message ?? error}`
                        );
                    }
                }
            },
            undefined,
            configBatchLimit
        );
    } catch (error: any) {
        logger.error(`[job-archive - CRON] tick threw error: ${error?.message ?? error}`);
    } finally {
        logger.info(
            `[job-archive - CRON] tick END | durationMs=${Date.now() - tickStartMs} configs=${configCount} archived=${archivedTotal}`
        );
    }
};

export { archiveBackupJob };
