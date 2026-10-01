import { createAwsEventScheduler, getAwsEventSchedule } from "../services/third-party/event-bridge";
import { logger } from "../middlewares";
import { NODE_ENV } from "../constant";

export interface ISystemSchedulePayload {
    purpose: string;
    isSyncPayment?: boolean;
    isSyncObject?: boolean;
    isLogsArchive?: boolean;
    isSyncSalesforceRefreshToken?: boolean;
}

interface ISystemScheduleJob {
    name: string;
    scheduleExpression: string;
    payload: ISystemSchedulePayload;
}

const SYSTEM_EVENT_SCHEDULES: ISystemScheduleJob[] = [
    {
        name: "datavault-daily-system-job-3am",
        scheduleExpression: "cron(0 3 * * ? *)",
        payload: {
            purpose: "DAILY_MAINTENANCE",
            isSyncObject: true,
            isSyncPayment: true,
            isLogsArchive: true,
            isSyncSalesforceRefreshToken: true,
        },
    },
    {
        name: "datavault-daily-system-job-07am",
        scheduleExpression: "cron(0 7 * * ? *)",
        payload: {
            purpose: "RUN_EMR",
        },
    },
    // {
    //     name: "datavault-daily-system-job-7pm",
    //     scheduleExpression: "cron(0 19 * * ? *)",
    //     payload: {
    //         purpose: "RUN_EMR",
    //     },
    // },
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
