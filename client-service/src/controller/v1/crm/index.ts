import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createOAuthState,
  disconnectCrm,
  getCrmById,
  getCrmTokens,
  getCrmsByUser,
  getOAuthState,
  getSalesforceLoginUrl,
  getSalesforceProfile,
  getSalesforceToken,
  reconnectCrm,
  upsertCrm,
  updateCrmCredentials,
} from '../../../services';
import {
  refreashSalesforceToken,
  SalesforceAuthExpiredError,
  SalesforceEnvironment,
} from '../../../services/third-party/salesforce';
import { wrapController } from '../../../utils/helper';

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
  const { crmName, crmId, environment, customUrl } = req.query;

  if (!crmName && !crmId) {
    makeResponse(req, res, 400, false, 'crm_name_required');
    return;
  }

  const env = (environment as SalesforceEnvironment) ?? 'production';

  if (env === 'custom' && !customUrl) {
    makeResponse(req, res, 400, false, 'custom_url_required');
    return;
  }

  const userId = req.user!.userId;
  let resolvedCrmName = String(crmName ?? '');
  let oauthStateKey: string | undefined;

  if (!resolvedCrmName && crmId) {
    const crm = await getCrmById(String(crmId));
    if (!crm || crm.userId !== userId) {
      makeResponse(req, res, 404, false, 'not_found');
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
        env,
        customUrl ? String(customUrl) : undefined
      );
      await createOAuthState(
        state,
        codeVerifier,
        userId,
        resolvedCrmName,
        crmId ? String(crmId) : undefined,
        env,
        customUrl ? String(customUrl) : undefined
      );
      redirectUrl = url;
      break;
    }
  }

  makeResponse(req, res, 200, true, 'fetch', { redirectUrl });
};

const crmCodeHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
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
          oauthState.environment,
          oauthState.customUrl
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

  const existingCrms = await getCrmsByUser(oauthState.userId);
  const { data: sfProfile } = await getSalesforceProfile(
    {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      userId: oauthState.userId,
    },
    oauthState.environment,
    oauthState.customUrl
  );

  const duplicate = existingCrms.find(
    (i) =>
      i.crmId !== oauthState.crmId &&
      i.crmProfile?.organizationId === sfProfile.organization_id &&
      i.crmProfile?.userId === sfProfile.user_id &&
      i.isConnected === true
  );
  if (duplicate) {
    makeResponse(req, res, 409, false, 'exit');
    return;
  }

  const nextCrmProfile = {
    instanceUrl: token.instance_url,
    organizationId: sfProfile.organization_id,
    userId: sfProfile.user_id,
    name: sfProfile.name,
    email: sfProfile.email,
    username: sfProfile.preferred_username,
    photoUrl: sfProfile.photos?.thumbnail,
  };

  const nextCrmCredentials = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  };

  if (oauthState.crmId) {
    const reconnected = await reconnectCrm({
      crmId: oauthState.crmId,
      crmProfile: nextCrmProfile,
      crmCredentials: nextCrmCredentials,
      environment: oauthState.environment,
      customUrl: oauthState.customUrl,
    });

    if (!reconnected) {
      makeResponse(req, res, 404, false, 'not_found');
      return;
    }
  } else {
    await upsertCrm({
      userId: oauthState.userId,
      crmName: oauthState.crmName,
      crmProfile: nextCrmProfile,
      crmCredentials: nextCrmCredentials,
      environment: oauthState.environment,
      customUrl: oauthState.customUrl,
    });
  }

  makeResponse(req, res, 200, true, 'fetch');
};

const crmListHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const crms = await getCrmsByUser(req.user!.userId);

  makeResponse(
    req,
    res,
    200,
    true,
    'fetch',
    crms.map((crm) => ({
      ...crm,
      encryptedCredentials: undefined,
      iv: undefined,
    }))
  );
};

const crmDisconnectHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  const disconnected = await disconnectCrm(String(crmId));

  if (!disconnected) {
    makeResponse(req, res, 400, false, 'not_exit');
    return;
  }

  makeResponse(req, res, 200, true, 'update');
};

const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crmId } = req.query;

  if (!crmId) {
    makeResponse(req, res, 400, false, 'crm_id_required');
    return;
  }

  const crm = await getCrmById(String(crmId));
  if (!crm) {
    makeResponse(req, res, 404, false, 'not_found');
    return;
  }

  const tokens = getCrmTokens(crm);

  let refreshed: any;
  try {
    refreshed = await refreashSalesforceToken(tokens.refresh_token, crm.environment, crm.customUrl);
  } catch {
    throw new SalesforceAuthExpiredError();
  }

  const newAccessToken: string = refreshed.access_token;
  const newRefreshToken: string = refreshed.refresh_token ?? tokens.refresh_token;

  await updateCrmCredentials(
    String(crmId),
    {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
    },
    crm.userId
  );

  makeResponse(req, res, 200, true, 'update', refreshed);
};

export const crmController = wrapController({
  crmLoginHanlder,
  crmCodeHanlder,
  crmListHandler,
  crmDisconnectHandler,
  crmRefreshTokenHandler,
});
