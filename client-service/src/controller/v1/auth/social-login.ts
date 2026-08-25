import { v4 as uuidv4 } from 'uuid';
import { fullAccessPermissions } from '../../../assets';
import {
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY,
  SALESFORCE_LOGIN_REDIRECT_URI,
  STANDARD_OBJECT_LIST,
  STATUS,
} from '../../../constant';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createOAuthState,
  createSession,
  createUser,
  getOAuthState,
  getSalesforceLoginUrl,
  getSalesforceProfile,
  getSalesforceToken,
  getUser,
  upsertCrm,
  updateUser,
  SalesforceEnvironment,
  SalesforceTokens,
  getCrmByOrgId,
  getUserByCrmProfileUserId,
  createRole,
  getUsersByContactEmail,
  getDecryptedCrmCredential,
} from '../../../services';
import { provisionEcaPermissionSet } from '../../../services/third-party/salesforce/eca-permission-set';
import { ICrm, IUser } from '../../../models';
import { encrypt } from '../../../utils/encryption';
import {
  generateTokens,
  parseExpiryToSeconds,
  wrapController,
} from '../../../utils/helper';
import { getSettingsByUserAndCrm, upsertSettings } from '../../../services/settings';

const parseSalesforceError = (error: any): string | null => {
  try {
    const json = error?.message?.replace(/^HTTP Error \d+:\s*/, '');
    return JSON.parse(json)?.error ?? null;
  } catch {
    return null;
  }
};

const socialLoginHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { authProvider, environment, customUrl, userId } = req.query as { authProvider: string, environment: SalesforceEnvironment, customUrl: string, userId: string };

  if (!authProvider) {
    makeResponse(req, res, 400, false, 'auth_provider_required');
    return;
  }

  const authProviderStr = String(authProvider).toLowerCase();

  let authorizationUrl;

  switch (authProviderStr) {
    case 'salesforce': {
      const { url, codeVerifier, state } = getSalesforceLoginUrl(undefined, SALESFORCE_LOGIN_REDIRECT_URI, environment, customUrl);
      await createOAuthState(state, codeVerifier, userId, authProviderStr, environment, customUrl);
      authorizationUrl = url;
      break;
    }
    default:
      makeResponse(req, res, 400, false, 'unsupported_auth_provider');
      return;
  }

  makeResponse(req, res, 200, true, 'fetch', { authorizationUrl });
};

const isProduction = process.env.NODE_ENV === 'production';

const baseCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict' as const,
};

const socialLoginCallbackHandler = async (
  req: IRequest,
  res: IResponse
): Promise<void> => {
  const { authProvider, code, state } = req.query;

  if (!authProvider) {
    makeResponse(req, res, 400, false, 'auth_provider_required');
    return;
  }

  const authProviderStr = String(authProvider).toLowerCase();

  const oauthState = await getOAuthState(String(state));
  if (!oauthState) {
    makeResponse(req, res, 400, false, 'invalid_or_expired_state');
    return;
  }

  if (oauthState.crmName !== authProviderStr) {
    makeResponse(req, res, 400, false, 'invalid_auth_provider');
    return;
  }

  let token: any = null;
  let sfProfile: any = null;

  try {
    switch (authProviderStr) {
      case 'salesforce': {
        token = await getSalesforceToken(String(code), oauthState.codeVerifier, oauthState.environment, oauthState.customUrl, SALESFORCE_LOGIN_REDIRECT_URI);
        const { data } = await getSalesforceProfile(
          {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            userId: '',
          },
          oauthState.environment,
          oauthState.customUrl,
        );
        sfProfile = data;
        break;
      }
      default:
        makeResponse(req, res, 400, false, 'unsupported_auth_provider');
        return;
    }
  } catch (error: any) {
    const sfError = parseSalesforceError(error);
    if (sfError === 'invalid_grant') {
      makeResponse(req, res, 400, false, 'salesforce_code_expired');
      return;
    }
    throw error;
  }

  if (!token || !sfProfile) {
    makeResponse(req, res, 500, false, 'unknown_error');
    return;
  }

  // State created by the admin authorize flow is pinned to a specific Salesforce
  // user id; reject the callback if a different user's credentials completed the
  // login. Plain social-login states carry userId '' and skip this check.
  if (oauthState.userId && oauthState.userId !== sfProfile.user_id) {
    console.log('[social-login-callback] 401: state pinned to different user:', { expected: oauthState.userId, actual: sfProfile.user_id });
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  // Computed once and reused by both the create and update paths below, so a
  // newly-created user gets it on its first write instead of a second
  // update right after.
  const crmCredential = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  };
  const encrptedCrm = encrypt(JSON.stringify(crmCredential));

  // Check if user exists by email (only match active users)
  let user = await getUserByCrmProfileUserId(sfProfile.user_id);
  // Set when the user is created below — skips the redundant updateUser call
  // that would otherwise immediately follow a brand-new user's first write.
  let userJustCreated = false;
  const isAdminProvisioningFlow = Boolean(oauthState.isAdminUser && oauthState.adminUserSfProfile);

  if (isAdminProvisioningFlow) {
    const adminProfile = oauthState.adminUserSfProfile!;
    // Salesforce's OAuth token response carries its own authoritative
    // instance_url — the only domain guaranteed to accept this access_token.
    // It can differ from whatever domain was reported separately (e.g. Apex's
    // URL.getOrgDomainUrl() during admin authorization), so it must win here;
    // otherwise later API calls made against the wrong domain fail with
    // INVALID_SESSION_ID even though the token itself is perfectly valid.
    const instanceUrl = token.instance_url ?? user?.crmProfile?.instanceUrl ?? adminProfile.instanceUrl;
    const organizationId = user?.crmProfile?.organizationId ?? adminProfile.organizationId;
    const crmId = user?.crmId ?? (await getCrmByOrgId(organizationId))?.crmId ?? uuidv4();

    if (!instanceUrl) {
      makeResponse(req, res, 500, false, 'admin_provisioning_failed');
      return;
    }

    const salesforceTokens: SalesforceTokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      userId: user?.userId,
      customUrl: user?.customUrl ?? oauthState.customUrl,
    };
    // provisionEcaPermissionSet doesn't dereference crm's fields today — pass
    // the identity that's about to be persisted below rather than delay
    // resolving it until after provisioning has already succeeded.
    const crmIdentity: ICrm = {
      crmId,
      organizationId,
      crmName: 'salesforce',
      status: STATUS.active,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    // Disaster-proofing: this must succeed before any admin user/CRM data is
    // written below. A Salesforce provisioning fault must never leave a
    // half-created admin (role, user, CRM row, crmCredential) behind — either
    // the whole admin login provisions cleanly, or nothing is written at all.
    try {
      await provisionEcaPermissionSet(instanceUrl, salesforceTokens, crmIdentity, adminProfile.permissionSetName);
    } catch (error: any) {
      console.log('[social-login-callback] admin provisioning aborted — ECA permission-set failed, no data was written:', error?.message ?? error);
      makeResponse(req, res, 500, false, 'admin_provisioning_failed');
      return;
    }

    if (!user) {
      // First-time admin: configure-org deferred role + user creation to
      // here, after Salesforce has confirmed the login and ECA provisioning
      // above has already succeeded.
      const { username, email, firstName, lastName } = adminProfile;

      const roleName = 'Custom';
      const roleId = uuidv4();
      await createRole({ roleId, name: roleName, permissions: fullAccessPermissions });

      const userId = uuidv4();
      const crmProfile = { username, email, userId: sfProfile.user_id, instanceUrl, organizationId, firstName, lastName };
      // createUser is idempotent by crmProfile.userId (sfProfile.user_id) via
      // the lookup above — this branch only runs when no user was found for
      // this Salesforce user id, so repeated admin logins update rather than
      // duplicate the user (see the update path below).
      await createUser({
        crmProfile,
        role: { name: roleName, roleId },
        userId,
        crmId,
        firstName,
        lastName,
        status: STATUS.active,
        crmCredential: encrptedCrm,
        isCrmConnected: true,
        ...(oauthState.customUrl ? { customUrl: oauthState.customUrl } : {}),
      });
      await upsertCrm({
        userId,
        crmId,
        environment: oauthState.environment === 'custom' ? undefined : oauthState.environment,
        organizationId,
        crmName: 'salesforce',
        status: STATUS.active,
      });
      // createUser returns void and the GSI read is eventually consistent —
      // use the record we just wrote for the rest of the login flow.
      user = { userId, crmId, crmProfile, status: STATUS.active, isCrmConnected: true, customUrl: oauthState.customUrl } as IUser;
      userJustCreated = true;
    }

    const settingsExist = await getSettingsByUserAndCrm(user.userId);
    if (!settingsExist) {
      await upsertSettings({
        userId: user.userId,
        crmId: user.crmId,
        standardObjects: STANDARD_OBJECT_LIST.map((name) => ({ name, isDefault: true }))
      });
    }
  }

  if (!user) {
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  // Check user status
  if (user.status === STATUS.inactive) {
    makeResponse(req, res, 403, false, 'blocked_or_removed');
    return;
  }

  if (!userJustCreated) {
    await updateUser(
      { userId: user.userId },
      {
        crmCredential: encrptedCrm,
        isCrmConnected: true,
        ...(oauthState.customUrl ? { customUrl: oauthState.customUrl } : {}),
        ...(token.instance_url ? { crmProfile: { ...user.crmProfile, instanceUrl: token.instance_url } } : {}),
      });
    console.log('[social-login-callback] persisted crmProfile.instanceUrl:', token.instance_url ?? '(none returned by Salesforce — kept prior value)', 'prior value was:', user.crmProfile?.instanceUrl);
  }

  if (user.contactEmail) {
    const userAllCrm = await getUsersByContactEmail({ contactEmail: user.contactEmail });
    const userAnotherCrmList = userAllCrm.filter(user => user.userId != user.userId);

    for (let index = 0; index < userAnotherCrmList.length; index++) {
      const userAnotherCrm = userAnotherCrmList[index];

      if (userAnotherCrm.isCrmConnected && userAnotherCrm.crmCredential) {
        const userAnotherCrmToken = await getDecryptedCrmCredential(userAnotherCrm);
        try {
          await getSalesforceProfile(
            {
              accessToken: userAnotherCrmToken.access_token,
              refreshToken: userAnotherCrmToken.refresh_token,
              userId: '',
            },
            oauthState.environment,
            oauthState.customUrl,
          );
        } catch {
          await updateUser({ userId: user.userId }, { isCrmConnected: false });
        }
      }

    }
  }

  // Create session and generate tokens
  const deviceInfo = {
    userAgent: req.headers['user-agent'],
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress,
  };

  const ttlSeconds = parseExpiryToSeconds(JWT_REFRESH_EXPIRY);
  const session = await createSession(user.userId, ttlSeconds, deviceInfo);
  const tokens = generateTokens(user.userId, session.sessionId);

  // Set cookies
  res.cookie('accessToken', tokens.accessToken, {
    ...baseCookieOptions,
    maxAge: parseExpiryToSeconds(JWT_ACCESS_EXPIRY) * 1000,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...baseCookieOptions,
    maxAge: parseExpiryToSeconds(JWT_REFRESH_EXPIRY) * 1000,
  });

  makeResponse(req, res, 200, true, 'login');
};

export const socialLoginController = wrapController({
  socialLoginHandler,
  socialLoginCallbackHandler,
});
