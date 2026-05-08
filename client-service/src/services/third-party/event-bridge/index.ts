import {
    SchedulerClient,
    CreateScheduleCommand,
    UpdateScheduleCommand,
    DeleteScheduleCommand,
    DeleteScheduleCommandOutput,
    FlexibleTimeWindowMode,
    ScheduleState,
    CreateScheduleCommandOutput,
    UpdateScheduleCommandOutput,
} from "@aws-sdk/client-scheduler";
import { AWS_EVENT_BUS_ARN, AWS_EVENT_DETAIL_TYPE, AWS_EVENT_SOURCE, AWS_REGION, AWS_SCHEDULER_ROLE_ARN } from "../../../constant";


const scheduler = new SchedulerClient({ region: AWS_REGION });

interface ScheduleInput {
    name: string;
    scheduleExpression: string;
    payload?: Record<string, unknown>;
}

const buildParams = ({ name, scheduleExpression, payload }: ScheduleInput) => ({
    Name: name,
    ScheduleExpression: scheduleExpression,
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
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
    const { name, scheduleExpression, payload } = input;

    try {
        return await scheduler.send(new CreateScheduleCommand(buildParams({ name, scheduleExpression, payload })));
    } catch (err: any) {
        if (err.name === "ConflictException")
            throw new Error(`Schedule "${name}" already exists. Use update instead.`);
        throw err;
    }
};

const updateAwsEventSchedule = async (input: ScheduleInput): Promise<UpdateScheduleCommandOutput> => {
    const { name, scheduleExpression, payload } = input;

    try {
        return await scheduler.send(
            new UpdateScheduleCommand({ ...buildParams({ name, scheduleExpression, payload }), State: ScheduleState.ENABLED })
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

export { createAwsEventScheduler, updateAwsEventSchedule, deleteAwsEventScheduler };
