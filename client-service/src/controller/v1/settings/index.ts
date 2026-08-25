import { IRequest, IResponse, makeResponse } from '../../../lib';
import { deleteStandardObject, getSettingsByUserAndCrm, upsertSettings } from '../../../services';
import { wrapController } from '../../../utils/helper';

const getSettingsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const crmId = req.user!.crmId || String(req.query.crmId);

  const settings = await getSettingsByUserAndCrm(userId, crmId);
  makeResponse(req, res, 200, true, 'fetch', settings);
};

const upsertSettingsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { status } = req.body;
  let { standardObjects } = req.body;

  const settings = await getSettingsByUserAndCrm(userId);
  const alreadyExistNames = settings?.standardObjects.map((s: any) => s.name);

  const filterObjects = standardObjects
    .filter((s: any) => !alreadyExistNames?.includes(s.name))
    .map((s: any) => ({ ...s, isDefault: false }));
  standardObjects = [...(settings?.standardObjects || []), ...filterObjects];

  await upsertSettings({ userId, standardObjects, status });
  makeResponse(req, res, 200, true, 'update', settings);
};

const deleteStandardObjectHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const crmId = req.user!.crmId || String(req.query.crmId);
  const { name } = req.query;

  if (!name) {
    makeResponse(req, res, 400, false, 'name_required');
    return;
  }

  const settings = await deleteStandardObject(userId, crmId, String(name));
  if (!settings) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'delete', settings);
};

export const settingsController = wrapController({
  getSettingsHandler,
  upsertSettingsHandler,
  deleteStandardObjectHandler,
});
