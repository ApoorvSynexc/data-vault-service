import { AWS_EVENT_DESTINATION_API_KEY } from "../../../../constant";
import { runLogsArchive } from "../../../../jobs/logs-archive-cron";
import { runPaymentSyncJob } from "../../../../jobs/payement-sync";
import { runEmrJob } from "../../../../jobs/run-emr-job";
import { runSyncSalesforceRefreshTokenJob } from "../../../../jobs/sync-salesforce-refresh-token";
import { IRequest, IResponse, makeResponse } from "../../../../lib";
import { logger } from "../../../../middlewares";
import { backupJob } from "./backup-job";

interface IEventPayload {
    purpose: "DAILY_MAINTENANCE" | "BACKUP_JOB" | "RUN_EMR",

    // BACKUP_JOB
    backupConfigId: string,
    userId: string,
    id?: string

    // DAILY_MAINTENANCE
    isRunEmr?: boolean;
    isSyncPayment?: boolean;
    isLogsArchive?: boolean;
    isSyncSalesforceRefreshToken?: boolean;
}

const eventBridgeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    try {
        logger.info('[Event Bridge] Triggered has been started');
        const event = req.body;
        const { purpose, ...restPayload } = event.detail as IEventPayload;

        const xAPiKey = req.headers?.['x-api-key'] as string | undefined;
        if (xAPiKey !== AWS_EVENT_DESTINATION_API_KEY) {
            return makeResponse(req, res, 401, false, 'unauthorized');
        }
        makeResponse(req, res, 200, true, 'fetch');

        logger.info(`[Event Bridge] Triggered set for purpose: ${purpose}`);
        switch (purpose) {
            case "DAILY_MAINTENANCE": {
                const { isSyncPayment, isLogsArchive, isSyncSalesforceRefreshToken } = restPayload;
                if (isSyncPayment) {
                    await runPaymentSyncJob();
                }
                if (isLogsArchive) {
                    await runLogsArchive();
                }
                if (isSyncSalesforceRefreshToken) {
                    await runSyncSalesforceRefreshTokenJob();
                }
            }
                break;
            case "RUN_EMR":
                await runEmrJob();
                break;
            case "BACKUP_JOB":
            default:
                await backupJob(restPayload);
                break;
        }

        logger.info('[Event Bridge] Triggered has been ended');
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_error';
        logger.error(`[Event Bridge] Triggered has been failed, error: ${message}`);
        return;
    }
}

export {
    eventBridgeHandler
}