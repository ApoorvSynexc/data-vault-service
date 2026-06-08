import { defaultRoles } from '../../../assets';
import {
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY,
  SALESFORCE_LOGIN_REDIRECT_URI,
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
  createSpace,
  updateUser,
  SalesforceEnvironment,
} from '../../../services';
import {
  generateTokens,
  parseExpiryToSeconds,
  wrapController,
} from '../../../utils/helper';

const parseSalesforceError = (error: any): string | null => {
  try {
    const json = error?.message?.replace(/^HTTP Error \d+:\s*/, '');
    return JSON.parse(json)?.error ?? null;
  } catch {
    return null;
  }
};

const socialLoginHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { authProvider, environment, customUrl }  = req.query as {authProvider: string,environment: SalesforceEnvironment, customUrl: string };

  if (!authProvider) {
    makeResponse(req, res, 400, false, 'auth_provider_required');
    return;
  }

  const authProviderStr = String(authProvider).toLowerCase();

  let authorizationUrl;

  switch (authProviderStr) {
    case 'salesforce': {
      const { url, codeVerifier, state } = getSalesforceLoginUrl(undefined, SALESFORCE_LOGIN_REDIRECT_URI, environment, customUrl);
      await createOAuthState(state, codeVerifier, '', authProviderStr);
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
        token = await getSalesforceToken(String(code), oauthState.codeVerifier);
        const { data } = await getSalesforceProfile({
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          userId: '',
        });
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

  // Check if user exists by email (only match active users)
  let user = await getUser({ 'contact.email': sfProfile.email, status: STATUS.active });

  // Create new user if doesn't exist
  if (!user) {
    const [firstName, ...lastNameParts] = sfProfile.name.split(' ');
    const lastName = lastNameParts.join(' ') || '';

    const userRole = defaultRoles.find((r) => r.name === 'user')!;
    await createUser({
      firstName,
      lastName,
      contact: {
        email: sfProfile.email,
        isEmailVerified: true,
      },
      authProvider: authProviderStr.toUpperCase(),
      status: STATUS.active,
      role: { name: userRole.name, roleId: userRole.roleId },
    });

    // Fetch the newly created user
    user = await getUser({ 'contact.email': sfProfile.email });

    if (!user) {
      makeResponse(req, res, 500, false, 'unknown_error');
      return;
    }

    // Create space for new user
    const space = await createSpace(user.userId);
    await updateUser({ userId: user.userId }, { spaceId: space.spaceId });
    user.spaceId = space.spaceId;

    // Create CRM connection for Salesforce
    if (authProviderStr === 'salesforce') {
      const crmProfile = {
        instanceUrl: token.instance_url,
        organizationId: sfProfile.organization_id,
        userId: sfProfile.user_id,
        name: sfProfile.name,
        email: sfProfile.email,
        username: sfProfile.preferred_username,
        photoUrl: sfProfile.photos?.thumbnail,
      };

      const crmCredentials = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
      };

      await upsertCrm({
        name: sfProfile?.name ?? "Admin",
        userId: user.userId,
        crmName: 'salesforce',
        crmProfile,
        crmCredentials,
        spaceId: space.spaceId,
      });
    }
  }

  // Check user status
  if (user.status === STATUS.inactive) {
    makeResponse(req, res, 403, false, 'blocked_or_removed');
    return;
  }

  // Create session and generate tokens
  const deviceInfo = {
    userAgent: req.headers['user-agent'],
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress,
  };

  const ttlSeconds = parseExpiryToSeconds(JWT_REFRESH_EXPIRY);
  const session = await createSession(user.userId, ttlSeconds, deviceInfo);
  const tokens = generateTokens(user.userId, session.sessionId, user.spaceId);

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
