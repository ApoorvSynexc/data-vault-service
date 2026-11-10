import {
    ActionAfterCompletion,
    SchedulerClient,
    CreateScheduleCommand,
    UpdateScheduleCommand,
    DeleteScheduleCommand,
    DeleteScheduleCommandOutput,
    GetScheduleCommand,
    GetScheduleCommandOutput,
    FlexibleTimeWindowMode,
    ScheduleState,
    CreateScheduleCommandOutput,
    UpdateScheduleCommandOutput,
} from "@aws-sdk/client-scheduler";
import { AWS_EVENT_BUS_ARN, AWS_EVENT_DETAIL_TYPE, AWS_EVENT_SOURCE, AWS_SCHEDULER_REGION, AWS_SCHEDULER_ROLE_ARN } from "../../../constant";
import { logger } from "../../../middlewares";

const scheduler = new SchedulerClient({ region: AWS_SCHEDULER_REGION });

interface ScheduleInput {
    name: string;
    scheduleExpression: string;
    timeZone?: string;
    payload?: Record<string, unknown>;
    startDate?: Date;
    endDate?: Date;
    // One-time at() schedules only: remove the schedule once it has fired.
    deleteAfterCompletion?: boolean;
}

const buildParams = ({ name, scheduleExpression, timeZone, payload, startDate, endDate, deleteAfterCompletion }: ScheduleInput) => ({
    Name: name,
    ...(deleteAfterCompletion && { ActionAfterCompletion: ActionAfterCompletion.DELETE }),
    ScheduleExpression: scheduleExpression,
    ScheduleExpressionTimezone: timeZone ?? "UTC",
    FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
    ...(startDate && { StartDate: startDate }),
    ...(endDate && { EndDate: endDate }),
    Target: {
        Arn: AWS_EVENT_BUS_ARN,
        RoleArn: AWS_SCHEDULER_ROLE_ARN,
        EventBridgeParameters: {
            DetailType: AWS_EVENT_DETAIL_TYPE,
            Source: AWS_EVENT_SOURCE,
        },
        Input: JSON.stringify(payload),
    },
});

const createAwsEventScheduler = async (input: ScheduleInput): Promise<CreateScheduleCommandOutput> => {
    const { name, scheduleExpression, timeZone, payload, startDate, endDate } = input;

    try {
        const result = await scheduler.send(new CreateScheduleCommand(buildParams({ name, scheduleExpression, timeZone, payload, startDate, endDate })));
        logger.info(`[event-bridge] Scheduled "${name}" created successfully.`);
        return result;
    } catch (err: any) {
        if (err.name === "ConflictException")
            throw new Error(`Schedule "${name}" already exists. Use update instead.`);
        throw err;
    }
};

const updateAwsEventSchedule = async (input: ScheduleInput): Promise<UpdateScheduleCommandOutput> => {
    const { name, scheduleExpression, timeZone, payload, startDate, endDate } = input;

    try {
        return await scheduler.send(
            new UpdateScheduleCommand({ ...buildParams({ name, scheduleExpression, timeZone, payload, startDate, endDate }), State: ScheduleState.ENABLED })
        );
    } catch (err: any) {
        if (err.name === "ResourceNotFoundException")
            throw new Error(`Schedule "${name}" does not exist. Use create instead.`);
        throw err;
    }
};

const deleteAwsEventScheduler = async (name: string): Promise<DeleteScheduleCommandOutput> => {
    try {
        return await scheduler.send(new DeleteScheduleCommand({ Name: name }));
    } catch (err: any) {
        if (err.name === "ResourceNotFoundException")
            throw new Error(`Schedule "${name}" does not exist.`);
        throw err;
    }
};

// Existence check used to keep schedule creation idempotent — returns
// undefined (rather than throwing) when the schedule isn't there yet, so
// callers can branch on it instead of parsing SDK error names themselves.
const getAwsEventSchedule = async (name: string): Promise<GetScheduleCommandOutput | undefined> => {
    try {
        return await scheduler.send(new GetScheduleCommand({ Name: name }));
    } catch (err: any) {
        if (err.name === "ResourceNotFoundException") return undefined;
        throw err;
    }
};

// at(yyyy-mm-ddThh:mm:ss) in UTC — EventBridge's one-time expression.
const toAtExpression = (date: Date): string => `at(${date.toISOString().slice(0, 19)})`;

// Creates or moves a self-deleting one-time schedule. Used for per-user
// Salesforce token retries and reconnect reminders.
const upsertOneTimeSchedule = async (name: string, runAt: Date, payload: Record<string, unknown>): Promise<void> => {
    const input: ScheduleInput = { name, scheduleExpression: toAtExpression(runAt), payload, deleteAfterCompletion: true };
    try {
        await scheduler.send(new CreateScheduleCommand(buildParams(input)));
    } catch (err: any) {
        if (err.name !== "ConflictException") throw err;
        await scheduler.send(new UpdateScheduleCommand({ ...buildParams(input), State: ScheduleState.ENABLED }));
    }
};

// Deletes a schedule; a missing one (already fired, or never created) is fine.
const deleteScheduleIfExists = async (name: string): Promise<void> => {
    try {
        await scheduler.send(new DeleteScheduleCommand({ Name: name }));
    } catch (err: any) {
        if (err.name !== "ResourceNotFoundException") throw err;
    }
};

export {
    createAwsEventScheduler,
    updateAwsEventSchedule,
    deleteAwsEventScheduler,
    getAwsEventSchedule,
    upsertOneTimeSchedule,
    deleteScheduleIfExists,
};
