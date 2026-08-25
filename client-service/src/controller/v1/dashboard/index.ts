import { IRequest, IResponse, makeResponse } from '../../../lib';
import { computeJobStats, getBackupConfigById, getBackupJobsByUser } from '../../../services';
import { wrapController } from '../../../utils/helper';

const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
};

const formatRecords = (count: number): string => {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
  return count.toString();
};

const overviewHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;

  try {
    const stats = await computeJobStats({
      indexName: 'userId-index',
      keyName: 'userId',
      keyValue: userId
    });

    const totalJobs = stats.completedJobs.count + stats.failedJobs.count;
    const successRate = totalJobs > 0
      ? Math.round((stats.completedJobs.count / totalJobs) * 10000) / 100
      : 0;

    const storageUsedBytes = stats.dataProcessed.bytes;
    const storageChange = stats.dataProcessed.weeklyChangePercent;
    const protectedRecordsCount = stats.protectedRecords.count;
    const recordsChange = stats.protectedRecords.weeklyChangePercent;

    const totalActiveJobs = stats.runningJobs.count;

    const overviewData = {
      protectedRecords: {
        value: formatRecords(protectedRecordsCount),
        change: recordsChange > 0 ? `+${recordsChange}%` : `${recordsChange}%`,
        period: 'vs last week',
      },
      storageUsed: {
        value: formatBytes(storageUsedBytes),
        change: storageChange > 0 ? `+${storageChange}%` : `${storageChange}%`,
        period: 'vs last week',
        progress: Math.min(Math.round((storageUsedBytes / (2 * 1024 * 1024 * 1024 * 1024)) * 100), 100),
      },
      backupSuccessRate: {
        value: `${successRate}%`,
        period: 'Last 7 Day',
        status: successRate >= 99 ? 'healthy' : successRate >= 95 ? 'warning' : 'critical',
      },
      activeJobs: {
        value: totalJobs,
        running: totalActiveJobs,
        period: 'Running',
      },
    };

    makeResponse(req, res, 200, true, 'fetch', overviewData);
  } catch (error) {
    throw error;
  }
};

const getLastBackupJob = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;

  const { items } = await getBackupJobsByUser(userId, { limit: 10 });

  const backupConfigMapping: Record<string, object> = {};
  for (let index = 0; index < items.length; index++) {
    const element: any = items[index];
    if (backupConfigMapping[element.backupConfigId]) {
      element.backupConfig = backupConfigMapping[element.backupConfigId]
    } else {
      const backupConfig = await getBackupConfigById(element.backupConfigId);
      if (backupConfig) {
        backupConfigMapping[element.backupConfigId] = {
          name: backupConfig.name,
          schedule: backupConfig.schedule,
        };
      }
      element.backupConfig = {
        name: backupConfig?.name,
        schedule: backupConfig?.schedule,
      }
    }
  }

  makeResponse(req, res, 200, true, 'fetch', items);
};

export const dashboardController = wrapController({
  overviewHandler,
  getLastBackupJob
});
