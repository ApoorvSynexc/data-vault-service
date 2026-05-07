import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import { createHash } from 'crypto';
import { logger } from '../../middlewares/logger';

const schedulerClient = new SchedulerClient({ region: process.env.AWS_REGION || 'us-east-1' });

export interface IScheduleConfig {
  frequency: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | string;
  interval: number;
  weekDays?: (('MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN') | string)[];
  monthDate?: number;
  time?: string; // HH:mm format, default: 00:00
}

export interface IScheduleInput {
  scheduleId: string;
  expression: string; // cron or rate expression
  timezone?: string;
  targetArn: string;
  roleArn: string;
  payload?: Record<string, any>;
  flexibleWindow?: number; // minutes
  targetType?: 'LAMBDA' | 'HTTP'; // NEW: support both Lambda and HTTP
}

export interface IScheduleInputWithConfig extends Omit<IScheduleInput, 'expression'> {
  scheduleConfig: IScheduleConfig;
  targetType?: 'LAMBDA' | 'HTTP';
}

export interface IScheduleResponse {
  scheduleArn: string;
  createdAt: Date;
  lastModifiedAt: Date;
}

export const createSchedule = async (input: IScheduleInput): Promise<IScheduleResponse> => {
  try {
    const targetType = input.targetType || 'LAMBDA';
    const target: any = {
      RoleArn: input.roleArn,
    };

    if (targetType === 'HTTP') {
      target.Arn = input.targetArn;
      target.HttpParameters = {
        HeaderParameters: {
          'Content-Type': 'application/json',
        },
      };
      if (input.payload) {
        target.Input = JSON.stringify(input.payload);
      }
    } else {
      target.Arn = input.targetArn;
      if (input.payload) {
        target.Input = JSON.stringify(input.payload);
      }
    }

    const command = new CreateScheduleCommand({
      Name: input.scheduleId,
      ScheduleExpression: input.expression,
      FlexibleTimeWindow: {
        Mode: FlexibleTimeWindowMode.FLEXIBLE,
        MaximumWindowInMinutes: input.flexibleWindow || 15,
      },
      Target: target,
      StartDate: new Date(),
    });

    const response = await schedulerClient.send(command);

    logger.info(`EventBridge schedule created: ${input.scheduleId}`, {
      scheduleArn: response.ScheduleArn,
      targetType,
    });

    return {
      scheduleArn: response.ScheduleArn || '',
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
  } catch (error) {
    logger.error(`Failed to create EventBridge schedule: ${input.scheduleId}`, error);
    throw new Error(
      `Failed to create schedule: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const updateSchedule = async (input: IScheduleInput): Promise<IScheduleResponse> => {
  try {
    const targetType = input.targetType || 'LAMBDA';
    const target: any = {
      RoleArn: input.roleArn,
    };

    if (targetType === 'HTTP') {
      target.Arn = input.targetArn;
      target.HttpParameters = {
        HeaderParameters: {
          'Content-Type': 'application/json',
        },
      };
      if (input.payload) {
        target.Input = JSON.stringify(input.payload);
      }
    } else {
      target.Arn = input.targetArn;
      if (input.payload) {
        target.Input = JSON.stringify(input.payload);
      }
    }

    const command = new UpdateScheduleCommand({
      Name: input.scheduleId,
      ScheduleExpression: input.expression,
      FlexibleTimeWindow: {
        Mode: FlexibleTimeWindowMode.FLEXIBLE,
        MaximumWindowInMinutes: input.flexibleWindow || 15,
      },
      Target: target,
    });

    const response = await schedulerClient.send(command);

    logger.info(`EventBridge schedule updated: ${input.scheduleId}`, {
      scheduleArn: response.ScheduleArn,
      targetType,
    });

    return {
      scheduleArn: response.ScheduleArn || '',
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
  } catch (error) {
    logger.error(`Failed to update EventBridge schedule: ${input.scheduleId}`, error);
    throw new Error(
      `Failed to update schedule: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const deleteSchedule = async (scheduleId: string): Promise<void> => {
  try {
    const command = new DeleteScheduleCommand({
      Name: scheduleId,
    });

    await schedulerClient.send(command);

    logger.info(`EventBridge schedule deleted: ${scheduleId}`);
  } catch (error) {
    logger.error(`Failed to delete EventBridge schedule: ${scheduleId}`, error);
    throw new Error(
      `Failed to delete schedule: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const getSchedule = async (scheduleId: string) => {
  try {
    const command = new GetScheduleCommand({
      Name: scheduleId,
    });

    const response = await schedulerClient.send(command);

    logger.info(`EventBridge schedule retrieved: ${scheduleId}`);

    return {
      scheduleId: response.Name,
      expression: response.ScheduleExpression,
      groupName: response.GroupName,
      state: response.State,
      targetArn: response.Target?.Arn,
      createdAt: response.CreationDate,
      lastModifiedAt: response.LastModificationDate,
    };
  } catch (error) {
    if ((error as any)?.name === 'ResourceNotFoundException') {
      logger.warn(`EventBridge schedule not found: ${scheduleId}`);
      return null;
    }
    logger.error(`Failed to get EventBridge schedule: ${scheduleId}`, error);
    throw new Error(
      `Failed to get schedule: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const listSchedules = async (filters?: { namePrefix?: string }) => {
  try {
    const command = new ListSchedulesCommand({
      NamePrefix: filters?.namePrefix,
      MaxResults: 50,
    });

    const response = await schedulerClient.send(command);

    logger.info('EventBridge schedules retrieved', { count: response.Schedules?.length || 0 });

    return {
      schedules: (response.Schedules || []).map((schedule) => ({
        scheduleId: schedule.Name,
        groupName: schedule.GroupName,
        state: schedule.State,
        targetArn: schedule.Target?.Arn,
        createdAt: schedule.CreationDate,
        lastModifiedAt: schedule.LastModificationDate,
      })),
      nextToken: response.NextToken,
    };
  } catch (error) {
    logger.error('Failed to list EventBridge schedules', error);
    throw new Error(
      `Failed to list schedules: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const generateScheduleId = (backupConfigId: string, userId: string): string => {
  const hash = createHash('sha256').update(`${userId}${backupConfigId}`).digest('hex').slice(0, 48);
  return `backup-${hash}`;
};

export const convertScheduleConfigToCron = (config: IScheduleConfig): string => {
  const [hours, minutes] = config.time ? config.time.split(':').map(Number) : [0, 0];

  switch (config.frequency) {
    case 'HOURLY':
      return `cron(0 */${config.interval} * * ? *)`;

    case 'DAILY':
      return `cron(${minutes} ${hours} */${config.interval} * ? *)`;

    case 'WEEKLY': {
      if (!config.weekDays || config.weekDays.length === 0) {
        throw new Error('weekDays required for WEEKLY frequency');
      }
      const dayMap: Record<string, number> = {
        MON: 2,
        TUE: 3,
        WED: 4,
        THU: 5,
        FRI: 6,
        SAT: 7,
        SUN: 1,
      };
      const days = config.weekDays.map((day) => dayMap[day]).join(',');
      return `cron(${minutes} ${hours} ? * ${days} *)`;
    }

    case 'MONTHLY': {
      if (!config.monthDate || config.monthDate < 1 || config.monthDate > 31) {
        throw new Error('monthDate required and must be 1-31 for MONTHLY frequency');
      }
      const monthMap: Record<string, number> = {
        JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
        JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
      };
      const months = config.selectedMonths && config.selectedMonths.length > 0
        ? config.selectedMonths.map((m) => monthMap[m]).join(',')
        : '*';
      return `cron(${minutes} ${hours} ${config.monthDate} ${months} ? *)`;
    }

    default:
      throw new Error(`Unsupported frequency: ${config.frequency}`);
  }
};

export const createScheduleFromConfig = async (
  input: IScheduleInputWithConfig
): Promise<IScheduleResponse> => {
  const expression = convertScheduleConfigToCron(input.scheduleConfig);
  return createSchedule({
    ...input,
    expression,
  });
};

export const updateScheduleFromConfig = async (
  input: IScheduleInputWithConfig
): Promise<IScheduleResponse> => {
  const expression = convertScheduleConfigToCron(input.scheduleConfig);
  return updateSchedule({
    ...input,
    expression,
  });
};
