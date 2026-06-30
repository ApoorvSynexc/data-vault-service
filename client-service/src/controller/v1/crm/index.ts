import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createOAuthState,
  disconnectCrm,
  getCrmById,
  getCrmsBySpace,
  getOAuthState,
  getSalesforceLoginUrl,
  getSalesforceProfile,
  getSalesforceToken,
  reconnectCrm,
  upsertCrm,
  updateCrm,
  deleteCrm,
  getBackupConfigsByCrm,
  createUser,
  getUser,
  getCrmByOrgId,
  updateUser,
  getUsers,
  getUsersByContactEmail,
} from '../../../services';
import {
  refreashSalesforceToken,
  SalesforceAuthExpiredError,
  SalesforceEnvironment,
} from '../../../services/third-party/salesforce';
import { AUTH_PROVIDER, STATUS } from '../../../constant';
import { wrapController } from '../../../utils/helper';
import { defaultRoles } from '../../../assets';
import { decrypt, encrypt } from '../../../utils/encryption';

// Extracts the Salesforce `error` code from httpRequest thrown messages.
// e.g. "HTTP Error 400: {"error":"invalid_grant",...}" → "invalid_grant"
const parseSalesforceError = (error: any): string | null => {
  try {
    const json = error?.message?.replace(/^HTTP Error \d+:\s*/, '');
    return JSON.parse(json)?.error ?? null;
  } catch {
    return null;
  }
};

const crmLoginHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmName, crmId, environment, name } = req.query;

  if (!crmName && !crmId) {
    makeResponse(req, res, 400, false, 'crm_name_required');
    return;
  }

  const env = (environment as SalesforceEnvironment) ?? 'production';

  const userId = req.user!.userId;
  let resolvedCrmName = String(crmName ?? '');
  let oauthStateKey: string | undefined;

  if (!resolvedCrmName && crmId) {
    const crm = await getCrmById(String(crmId));
    if (!crm) {
      makeResponse(req, res, 400, false, 'not_exist');
      return;
    }

    resolvedCrmName = crm.crmName;
    oauthStateKey = `crm-${crm.crmId}`;
  }

  let redirectUrl;

  switch (resolvedCrmName) {
    case 'salesforce':
    default: {
      const { url, codeVerifier, state } = getSalesforceLoginUrl(
        oauthStateKey,
        undefined,
        env
      );
      await createOAuthState(
        state,
        codeVerifier,
        userId,
        resolvedCrmName,
        crmId ? String(crmId) : undefined,
        env,
        undefined,
        name ? String(name) : undefined
      );
      redirectUrl = url;
      break;
    }
  }

  makeResponse(req, res, 200, true, 'fetch', { redirectUrl });
};

const crmCodeHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmName, code, state } = req.query;

  const oauthState = await getOAuthState(String(state));
  if (!oauthState) {
    makeResponse(req, res, 400, false, 'invalid_or_expired_state');
    return;
  }

  let token;
  try {
    switch (crmName) {
      case 'salesforce':
      default:
        token = await getSalesforceToken(
          String(code),
          oauthState.codeVerifier,
          oauthState.environment
        );
        break;
    }
  } catch (error: any) {
    const sfError = parseSalesforceError(error);
    if (sfError === 'invalid_grant') {
      makeResponse(req, res, 400, false, 'salesforce_code_expired');
      return;
    }
    throw error;
  }

  const { data: sfProfile } = await getSalesforceProfile(
    {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      userId: oauthState.userId,
    },
    oauthState.environment
  );

  const existingCrms = await getCrmByOrgId(sfProfile.organization_id);
  if (!existingCrms) {
    makeResponse(req, res, 409, false, 'not_exist');
    return;
  }

  const crmCredential = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  }
  const encrptedCrm = encrypt(JSON.stringify(crmCredential));
  await updateUser(
    { userId: user?.userId },
    {
      crmCredential: encrptedCrm,
      ...(oauthState.customUrl ? { customUrl: oauthState.customUrl } : {})
    }
  );

  makeResponse(req, res, 200, true, 'fetch');
};

const crmListHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user!;
  if (!user || !user.contactEmail) {
    return makeResponse(req, res, 400, false, 'unauthorized');
  }
  const users = await getUsersByContactEmail({ contactEmail: user.contactEmail });
  if (!users) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  for (let index = 0; index < users.length; index++) {
    const currentUser = users[index];
    const crm = await getCrmById(currentUser.crmId!);
    if (crm) {
      (users[index] as any).crm = crm;
    }
  }
  makeResponse(req, res, 200, true, 'fetch', users);
};

const crmDisconnectHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  const disconnected = await disconnectCrm(String(crmId));

  if (!disconnected) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'update');
};

const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const user = req.user;
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  if (!user) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const crm = await getCrmById(String(crmId));
  if (!crm) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const tokens = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
  let refreshed: any;
  try {
    refreshed = await refreashSalesforceToken(tokens.refresh_token, crm.environment);
  } catch {
    throw new SalesforceAuthExpiredError();
  }

  makeResponse(req, res, 200, true, 'update', refreshed);
};

const updateCrmHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId, ...body } = req.body;

  const crm = await getCrmById(String(crmId));
  if (!crm) {
    makeResponse(req, res, 404, false, 'not_exist');
    return;
  }

  const updatedCrm = await updateCrm(String(crmId), body);

  makeResponse(req, res, 200, true, 'update', updatedCrm);
};

const crmDeleteHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  const crm = await getCrmById(String(crmId));
  if (!crm) {
    makeResponse(req, res, 404, false, 'not_exist');
    return;
  }

  const backupConfigs = await getBackupConfigsByCrm(String(crmId), 1);
  if (backupConfigs.length > 0) {
    makeResponse(req, res, 400, false, 'backup_configs_exist');
    return;
  }

  const deleted = await deleteCrm(String(crmId));
  if (!deleted) {
    makeResponse(req, res, 400, false, 'deletion_failed');
    return;
  }

  makeResponse(req, res, 200, true, 'delete');
};

export const crmController = wrapController({
  crmLoginHanlder,
  crmCodeHanlder,
  crmListHandler,
  crmDisconnectHandler,
  crmRefreshTokenHandler,
  updateCrmHandler,
  crmDeleteHandler,
});
