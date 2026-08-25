import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getSettingsByUserAndCrm, upsertSettings } from '../../../services';
import { wrapController } from '../../../utils/helper';

const getSettingsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const crmId = req.user!.crmId || String(req.query.crmId);

  const settings = await getSettingsByUserAndCrm(userId, crmId);
  makeResponse(req, res, 200, true, 'fetch', settings);
};

const upsertSettingsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { crmId, standardObjects, status } = req.body;

  const settings = await upsertSettings({ userId, crmId, standardObjects, status });
  makeResponse(req, res, 200, true, 'update', settings);
};

export const settingsController = wrapController({
  getSettingsHandler,
  upsertSettingsHandler,
});
