import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { DURATION_TYPE, SCHEDULE_TYPE } from '../constant';
import { IBackupConfig, IScheduleConfig } from '../models';

dayjs.extend(utc);
dayjs.extend(timezone);

const toAwsCronExpression = (scheduleConfig: IScheduleConfig): string => {
  const s = scheduleConfig.scheduling;

  if (scheduleConfig.type === SCHEDULE_TYPE.oneTime && s?.frequency === DURATION_TYPE.once) {
    if (s.startDate && s.startTime) {
      return `cron(${s.startTime.split(':')[1]} ${s.startTime.split(':')[0]} ${new Date(s.startDate).getDate()} ${new Date(s.startDate).getMonth() + 1} ? ${new Date(s.startDate).getFullYear()})`;
    }
  }

  if (!s) {
    throw new Error('INCREMENTAL schedule requires a scheduling object');
  }

  switch (s.frequency) {
    case 'HOURLY': return `rate(${s.interval} hour${s.interval > 1 ? 's' : ''})`;
    case 'DAILY': return `rate(${s.interval} day${s.interval > 1 ? 's' : ''})`;
    case 'WEEKLY': return `rate(${s.interval * 7} days)`;
    case 'MONTHLY': {
      const [hour, minute] = (s.startTime ?? '00:00').split(':');
      return `cron(${minute} ${hour} ${s.monthDate ?? 1} * ? *)`;
    }
    case 'CUSTOM': {
      if (!s.startDate || !s.startTime) {
        throw new Error('CUSTOM schedule requires startDate and startTime');
      }
      // CUSTOM repeats every `interval` <customFrequency> unit — same underlying
      // rate()/cron() shape as the matching native frequency above, just keyed off
      // customFrequency instead of `frequency` itself. startDate/endDate anchor and
      // bound the recurrence via AWS's own StartDate/EndDate window (see
      // RECURRING_FREQUENCIES/computeAwsScheduleWindow below), not the expression.
      switch (s.customFrequency) {
        case 'DAILY':
          return `rate(${s.interval} day${s.interval > 1 ? 's' : ''})`;
        case 'WEEKLY':
          return `rate(${s.interval * 7} days)`;
        case 'MONTHLY': {
          // Same limitation as native MONTHLY above: AWS cron() has no "every N
          // months" step syntax, so interval > 1 isn't honored here — it fires
          // every month, on startDate's day-of-month, at startTime.
          const [hour, minute] = s.startTime.split(':');
          return `cron(${minute} ${hour} ${new Date(s.startDate).getDate()} * ? *)`;
        }
        default:
          throw new Error(`Unsupported customFrequency: ${s.customFrequency}`);
      }
    }
    default:
      throw new Error(`Unsupported schedule frequency: ${s.frequency}`);
  }
};

const combineDateAndTime = (dateStr: string, timeStr: string | undefined, tz: string): Date => {
  let result = dayjs.tz(dateStr, tz);
  if (timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    result = result.hour(hours).minute(minutes).second(0).millisecond(0);
  }
  return result.toDate();
};

const MS_PER_RATE_UNIT = { hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 } as const;

// HOURLY/DAILY/WEEKLY compile to AWS rate() expressions, which fire at fixed
// absolute-time intervals counted from the schedule's StartDate anchor (AWS
// treats "day" as exactly 86400s, not a calendar day) — so the next occurrence
// is anchor + k*step for the smallest k that lands strictly after `now`, not
// `now + one interval`, which drifts away from the real AWS fire times as soon
// as `now` isn't itself exactly on a previous occurrence.
const nextRateOccurrence = (
  anchor: dayjs.Dayjs | null,
  now: dayjs.Dayjs,
  amount: number,
  unit: keyof typeof MS_PER_RATE_UNIT
): Date => {
  if (!anchor || !anchor.isBefore(now)) {
    return (anchor ?? now).toDate();
  }
  const stepMs = amount * MS_PER_RATE_UNIT[unit];
  const elapsedMs = now.valueOf() - anchor.valueOf();
  const steps = Math.floor(elapsedMs / stepMs) + 1;
  return new Date(anchor.valueOf() + steps * stepMs);
};

const computeNextScheduledRun = (scheduleConfig: IScheduleConfig, from: Date = new Date()): Date => {
  const s = scheduleConfig.scheduling;
  const tz = scheduleConfig.timeZone || 'UTC';
  const now = dayjs.tz(from, tz);

  if (scheduleConfig.type === SCHEDULE_TYPE.oneTime && s?.frequency === DURATION_TYPE.once) {
    return s.startDate ? combineDateAndTime(s.startDate, s.startTime, tz) : from;
  }

  if (!s) {
    throw new Error('INCREMENTAL schedule requires a scheduling object');
  }

  const anchor = s.startDate ? dayjs.tz(combineDateAndTime(s.startDate, s.startTime, tz), tz) : null;

  switch (s.frequency) {
    case 'HOURLY':
      return nextRateOccurrence(anchor, now, s.interval || 1, 'hour');
    case 'DAILY':
      return nextRateOccurrence(anchor, now, s.interval || 1, 'day');
    case 'WEEKLY':
      return nextRateOccurrence(anchor, now, (s.interval || 1) * 7, 'day');
    case 'MONTHLY': {
      const day = s.monthDate ?? 1;
      const [hour, minute] = (s.startTime ?? '00:00').split(':').map(Number);
      // Once AWS's StartDate gates the schedule, no occurrence can land before it —
      // anchor the search there when it's still ahead of `now`.
      const reference = anchor && anchor.isAfter(now) ? anchor : now;
      let next = reference.date(day).hour(hour).minute(minute).second(0).millisecond(0);
      if (!next.isAfter(reference)) {
        next = next.add(1, 'month');
      }
      return next.toDate();
    }
    case 'CUSTOM': {
      if (!s.startDate) {
        throw new Error('CUSTOM schedule requires startDate and startTime');
      }
      // Mirrors the native DAILY/WEEKLY/MONTHLY branches above, keyed off
      // customFrequency instead of frequency — same anchor/reference logic.
      switch (s.customFrequency) {
        case 'DAILY':
          return nextRateOccurrence(anchor, now, s.interval || 1, 'day');
        case 'WEEKLY':
          return nextRateOccurrence(anchor, now, (s.interval || 1) * 7, 'day');
        case 'MONTHLY': {
          const day = anchor?.date() ?? dayjs.tz(s.startDate, tz).date();
          const [hour, minute] = (s.startTime ?? '00:00').split(':').map(Number);
          const reference = anchor && anchor.isAfter(now) ? anchor : now;
          let next = reference.date(day).hour(hour).minute(minute).second(0).millisecond(0);
          if (!next.isAfter(reference)) {
            next = next.add(1, 'month');
          }
          return next.toDate();
        }
        default:
          throw new Error(`Unsupported customFrequency: ${s.customFrequency}`);
      }
    }
    default:
      throw new Error(`Unsupported schedule frequency: ${s.frequency}`);
  }
};

// HOURLY/DAILY/WEEKLY/MONTHLY/CUSTOM compile to rate()/cron() expressions that carry
// no start (or end) instant of their own — AWS would otherwise start firing them
// immediately on creation instead of at the user's chosen startDate/startTime, and
// never stop. AWS's own StartDate/EndDate fields on the schedule (ignored for
// one-time schedules, so ONCE — which already encodes a fixed fire instant in the
// cron itself — is left alone) anchor and bound the window instead of reinventing
// it in the expression; for CUSTOM specifically, endDate is what actually stops
// the recurrence, since the rate()/cron() itself has no notion of an end.
const RECURRING_FREQUENCIES = new Set(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']);
const computeAwsScheduleWindow = (scheduleConfig: IScheduleConfig): { startDate?: Date; endDate?: Date } => {
  const s = scheduleConfig.scheduling;
  if (!s || !RECURRING_FREQUENCIES.has(s.frequency)) {
    return {};
  }

  const tz = scheduleConfig.timeZone || 'UTC';
  return {
    startDate: s.startDate ? combineDateAndTime(s.startDate, s.startTime, tz) : undefined,
    endDate: s.endDate ? dayjs.tz(s.endDate, tz).endOf('day').toDate() : undefined,
  };
};

// Single source of truth for the two schedule-name shapes AWS Scheduler entries are
// keyed by — a backup/archival config's own schedule, and (archival only) the
// per-object schedule nested inside one. create/update/delete must all resolve to
// the same name for a given id or the delete-side lookup silently orphans the AWS
// schedule, so every call site should go through these instead of inlining the string.
const buildBackupScheduleName = (backupConfigId: string): string => `datavault-${backupConfigId}`;
const buildArchivalObjectScheduleName = (objectId: string): string => `datavault-objId-${objectId}`;

// Shared by backup-config (one schedule per config) and archival-config (one
// schedule per scheduled object) — assembles everything createAwsEventScheduler/
// updateAwsEventSchedule need, including the startDate/endDate anchoring above.
const buildScheduleInput = (name: string, scheduleConfig: IScheduleConfig, payload: Record<string, unknown>) => ({
  name,
  scheduleExpression: toAwsCronExpression(scheduleConfig),
  timeZone: scheduleConfig.timeZone,
  payload,
  ...computeAwsScheduleWindow(scheduleConfig),
});

const buildEventScheduleInput = (config: IBackupConfig) =>
  buildScheduleInput(buildBackupScheduleName(config.backupConfigId), config.scheduleConfig!, {
    backupConfigId: config.backupConfigId,
    userId: config.userId,
  });

export {
  toAwsCronExpression,
  computeNextScheduledRun,
  computeAwsScheduleWindow,
  buildBackupScheduleName,
  buildArchivalObjectScheduleName,
  buildScheduleInput,
  buildEventScheduleInput,
};
