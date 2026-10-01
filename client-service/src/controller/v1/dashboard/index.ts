import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getBackupConfigById, getBackupJobOverview, getBackupJobsByUser, getBackupOverview, getRestoreJobsByUserId, getRestoreOverview } from '../../../services';
import { wrapController } from '../../../utils/helper';

const getLastNBackupJobs = async (userId: string, limit: number, type?: 'NORMAL' | 'ARCHIVAL') => {
  const { items } = await getBackupJobsByUser(userId, { limit, type });

  const backupConfigMapping: Record<string, object> = {};
  for (let index = 0; index < items.length; index++) {
    let element: any = items[index];
    element = { ...element, source: undefined, destination: { type: element.destination.type } };
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

  return items;
};

const getLastNRestoreJobs = async (userId: string, limit: number) => {
  return getRestoreJobsByUserId(userId, { limit });
};

const getLastBackupJob = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const module = req.query.module as 'backup' | 'archival' | 'restore';

  switch (module) {
    case 'backup': {
      const jobs = await getLastNBackupJobs(userId, 10, 'NORMAL');
      return makeResponse(req, res, 200, true, 'fetch', jobs);
    }
    case 'archival': {
      const jobs = await getLastNBackupJobs(userId, 10, 'ARCHIVAL');
      return makeResponse(req, res, 200, true, 'fetch', jobs);
    }
    case 'restore': {
      const jobs = await getRestoreJobsByUserId(userId, { limit: 10 });
      for (let index = 0; index < jobs.length; index++) {
        let element = jobs[index];
        element = { ...element, source: { ...element.source, encryptedKeys: (undefined as any) } }
      }
      return makeResponse(req, res, 200, true, 'fetch', jobs);
    }
    default:
      return makeResponse(req, res, 400, false, 'params_required');
  }

};

const overviewV2Handler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const module = req.query.module as 'backup' | 'archival' | 'restore';

  switch (module) {
    case 'backup': {
      const overview = await getBackupOverview(userId, 'NORMAL');
      const jobOverview = await getBackupJobOverview(userId, 'NORMAL');
      return makeResponse(req, res, 200, true, 'fetch', { ...overview, jobOverview });
    }
    case 'archival': {
      const overview = await getBackupOverview(userId, 'ARCHIVAL');
      const jobOverview = await getBackupJobOverview(userId, 'ARCHIVAL');
      return makeResponse(req, res, 200, true, 'fetch', { ...overview, jobOverview });
    }
    case 'restore': {
      const overview = await getRestoreOverview(userId);
      return makeResponse(req, res, 200, true, 'fetch', overview);
    }
    default:
      return makeResponse(req, res, 400, false, 'params_required');
  }
}

export const dashboardController = wrapController({
  getLastBackupJob,
  overviewV2Handler,
});
