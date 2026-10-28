import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  deleteStandardObject,
  getRole,
  getSettingsByUser,
  getUser,
  getUsersByCrmId,
  listTokenEventsByCrm,
  listTokenEventsByUser,
  upsertSettings,
} from '../../../services';
import { SALESFORCE_TOKEN_STATUS } from '../../../constant';

const TOKEN_EVENT_LOOKBACK_DAYS = 30;
import { wrapController } from '../../../utils/helper';

const getSettingsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;

  const settings = await getSettingsByUser(userId);
  makeResponse(req, res, 200, true, 'fetch', settings);
};

const upsertSettingsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { status, salesforceApiThreshold, rollbackWindow, notification } = req.body;
  let { standardObjects } = req.body;

  const settings = await getSettingsByUser(userId);

  if (standardObjects) {
    const alreadyExistNames = settings?.standardObjects.map((s: any) => s.name);
    const filterObjects = standardObjects
      .filter((s: any) => !alreadyExistNames?.includes(s.name))
      .map((s: any) => ({ ...s, isDefault: false }));
    standardObjects = [...(settings?.standardObjects || []), ...filterObjects];
  }

  await upsertSettings({ userId, standardObjects, salesforceApiThreshold, rollbackWindow, notification, status });
  makeResponse(req, res, 200, true, 'update', settings);
};

// The caller's own Salesforce connection health: current token status plus
// the last 30 days of token events (never raw tokens — fingerprints only).
const getSalesforceConnectionHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const user = await getUser({ userId });
  if (!user) {
    makeResponse(req, res, 404, false, 'not_exist');
    return;
  }

  const since = new Date(Date.now() - TOKEN_EVENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const events = await listTokenEventsByUser(userId, since);
  makeResponse(req, res, 200, true, 'fetch', {
    tokenStatus: user.tokenStatus ?? SALESFORCE_TOKEN_STATUS.ready,
    isCrmConnected: !!user.isCrmConnected,
    refreshing: !!user.refreshLockedUntil && user.refreshLockedUntil > Date.now(),
    tokenStatusChangedAt: user.tokenStatusChangedAt,
    tokenNextRetryAt: user.tokenNextRetryAt,
    tokenLastError: user.tokenLastError,
    lastRefreshAt: user.lastRefreshAt,
    refreshCount: user.refreshCount ?? 0,
    expiredAt: user.expiredAt,
    events,
  });
};

// Org-wide view for admins (settings.write): every connected user's token
// status plus the org's token events for the last 30 days. The settings
// module is exempt from the ACL gateway, so the permission is checked here.
const getOrgSalesforceConnectionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user!;
  const role = await getRole({ roleId: user.role.roleId });
  if (!role?.permissions?.includes('settings.write')) {
    makeResponse(req, res, 403, false, 'insufficient_permission');
    return;
  }
  if (!user.crmId) {
    makeResponse(req, res, 400, false, 'crm_not_found');
    return;
  }

  const since = new Date(Date.now() - TOKEN_EVENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [orgUsers, events] = await Promise.all([
    getUsersByCrmId(user.crmId),
    listTokenEventsByCrm(user.crmId, since),
  ]);

  makeResponse(req, res, 200, true, 'fetch', {
    users: orgUsers.map((orgUser) => ({
      userId: orgUser.userId,
      firstName: orgUser.firstName,
      lastName: orgUser.lastName,
      email: orgUser.contactEmail,
      isCrmConnected: !!orgUser.isCrmConnected,
      tokenStatus: orgUser.tokenStatus ?? SALESFORCE_TOKEN_STATUS.ready,
      tokenStatusChangedAt: orgUser.tokenStatusChangedAt,
      tokenNextRetryAt: orgUser.tokenNextRetryAt,
      tokenLastError: orgUser.tokenLastError,
      lastRefreshAt: orgUser.lastRefreshAt,
      refreshCount: orgUser.refreshCount ?? 0,
      reminderSeq: orgUser.reminderSeq ?? 0,
    })),
    events,
  });
};

const deleteStandardObjectHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const { name } = req.query;

  if (!name) {
    makeResponse(req, res, 400, false, 'name_required');
    return;
  }

  const settings = await deleteStandardObject(userId, String(name));
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
  getSalesforceConnectionHandler,
  getOrgSalesforceConnectionsHandler,
});
