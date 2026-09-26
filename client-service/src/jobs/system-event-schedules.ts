import { createAwsEventScheduler, getAwsEventSchedule } from "../services/third-party/event-bridge";
import { logger } from "../middlewares";
import { NODE_ENV } from "../constant";

export interface ISystemSchedulePayload {
    purpose: string;
    isRunEmr?: boolean;
    isSyncPayment?: boolean;
    isLogsArchive?: boolean;
    isSyncSalesforceRefreshToken?: boolean;
}

interface ISystemScheduleJob {
    name: string;
    scheduleExpression: string;
    payload: ISystemSchedulePayload;
}

console.log("isProduction ", NODE_ENV === "production");
const SYSTEM_EVENT_SCHEDULES: ISystemScheduleJob[] = [
    {
        name: "datavault-daily-system-job-3am",
        scheduleExpression: "cron(0 3 * * ? *)",
        payload: {
            purpose: "DAILY_MAINTENANCE",
            isRunEmr:true,
            isSyncPayment: true,
            isLogsArchive: true,
            isSyncSalesforceRefreshToken: true,
        },
    },
    {
        name: "datavault-daily-system-job-11am",
        scheduleExpression: "cron(0 11 * * ? *)",
        payload: {
            purpose: "DAILY_MAINTENANCE",
            isRunEmr: NODE_ENV === "production" ? true : false,
            isSyncPayment: false,
            isLogsArchive: false,
            isSyncSalesforceRefreshToken: false,
        },
    },
    {
        name: "datavault-daily-system-job-7pm",
        scheduleExpression: "cron(0 19 * * ? *)",
        payload: {
            purpose: "DAILY_MAINTENANCE",
            isRunEmr: NODE_ENV === "production" ? true : false,
            isSyncPayment: false,
            isLogsArchive: false,
            isSyncSalesforceRefreshToken: false,
        },
    },
];

// Ensures every entry in SYSTEM_EVENT_SCHEDULES exists on EventBridge
// Scheduler — verifies each one first and only creates what's missing, so
// this is safe to call on every app boot without re-creating/touching
// schedules that are already there.
export const registerSystemEventSchedules = async (): Promise<void> => {
    for (const job of SYSTEM_EVENT_SCHEDULES) {
        try {
            const existing = await getAwsEventSchedule(job.name);
            if (existing) {
                logger.info(`[system-event-schedules] "${job.name}" already exists — skipping`);
                continue;
            }

            await createAwsEventScheduler({
                name: job.name,
                scheduleExpression: job.scheduleExpression,
                payload: { ...job.payload },
            });
        } catch (error) {
            logger.error(`[system-event-schedules] failed to register "${job.name}": `, error);
        }
    }
};
