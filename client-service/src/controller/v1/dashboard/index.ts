import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';

const getOverviewHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const spaceId = req.user?.spaceId;
  const userId = req.user!.userId;

  const overviewData = {
    protectedRecords: {
      value: '2.2B',
      change: '+2.1%',
      period: 'vs last week',
    },
    storageUsed: {
      value: '2.2 TB',
      change: '+2.5%',
      period: 'vs last week',
      progress: 60,
    },
    backupSuccessRate: {
      value: '99.98%',
      period: 'Last 7 Day',
      status: 'healthy',
    },
    activeJobs: {
      value: 14,
      running: 3,
      period: 'Running',
    },
  };

  makeResponse(req, res, 200, true, 'fetch', overviewData);
};

export const dashboardController = wrapController({
  getOverviewHandler,
});
