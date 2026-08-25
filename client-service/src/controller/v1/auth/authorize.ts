import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import {
  getCrmByOrgId,
  upsertCrm,
  updateCrm,
  getUserByCrmProfileUserId,
  updateUser,
  createOAuthState,
  getSalesforceLoginUrl,
} from '../../../services';
import { decrypt, encrypt, generateOrgEncryptionKey, readEnvelope } from '../../../utils/encryption';
import { encryptSalesforceResponse, resolveOrgKey } from '../../../utils/salesforce-crypto';
import { STATUS, SALESFORCE_LOGIN_REDIRECT_URI } from '../../../constant';

interface IAuthorizeOrganizationPayload {
  orgId: string;
  instanceUrl: string;
  environment?: 'production' | 'sandbox' | 'custom';
}

interface IAuthorizeUserPayload {
  user_id: string;
  org_id: string;
  user_email: string;
  user_username: string;
  user_first_name: string;
  user_last_name: string;
  instance_url: string;
  org_environment?: 'production' | 'sandbox';
  permission_set_name: string; // existing Permission Set API name, used for ECA provisioning
}


const authorizationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  try {

    let plaintext: string;
    try {
      plaintext = decrypt(readEnvelope(req.body));
    } catch (error: any) {
      console.log('[configure-org] 401: decrypt/envelope failed:', error?.message ?? error);
      makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }

    const payload: {type?: string; user_details?: IAuthorizeUserPayload; org_details?: IAuthorizeOrganizationPayload} = JSON.parse(plaintext);
    const finalResponse: any = {};
    if (payload.type === 'org' && payload.org_details) {
      finalResponse.org = await authorizeOrgHandler(payload.org_details);
    }
    if (payload.user_details) {
      const crm = await getCrmByOrgId(payload.user_details.org_id);
      if (!crm) {
        console.log('[configure-org] 401: org not registered for user authorization:', payload.user_details.org_id);
        throw new Error('Org not registered for user authorization');
      }
      finalResponse.user = encryptSalesforceResponse(crm, await authorizeUserHandler(payload.user_details));
    }

    makeResponse(req, res, 200, true, 'fetch', encrypt(JSON.stringify(finalResponse)));
  } catch (error) {
    console.error('Error in authorizeOrganizationHandler:', error);
    makeResponse(req, res, 500, false, 'unknown_error');
  }
};


const authorizeOrgHandler = async (payload: IAuthorizeOrganizationPayload): Promise<{encryptionKey: any}> => {
  // DataVaultAdminAuthorizationService.authorizeOrganization() (invoked from the
  // LWC's Authorize Admin flow, not the Post Install Handler — the installing user
  // has no Named Credential access at install time) encrypts { orgId, instanceUrl }
  // as a whole with the shared Bootstrap Key and sends the envelope as the entire
  // request body — there's no separate plaintext orgId to cross-check against, so a
  // successful decrypt (and presence of the expected fields) is the validation itself.
  //
  // This endpoint stays single-layer (Bootstrap Key only) — there's no org key to
  // wrap with yet, since registering the org is what produces one. Every other
  // Salesforce-facing endpoint uses the two-layer scheme (see
  // utils/salesforce-crypto.ts) once an org key exists.
  const { orgId, instanceUrl } = payload;
  if (!orgId || !instanceUrl) {
    console.log('[configure-org] 401: missing required field(s):', {
      hasOrgId: !!orgId,
      hasInstanceUrl: !!instanceUrl,
    });
    throw new Error('Missing required field(s) in authorizeOrgHandler payload');
  }

  let crm = await getCrmByOrgId(orgId);
  let rawEncryptionKey: string;

  if (!crm) {
    rawEncryptionKey = generateOrgEncryptionKey();
    crm = await upsertCrm({
      crmId: uuidv4(),
      organizationId: orgId,
      crmName: 'salesforce',
      instanceUrl,
      encryptionKey: encrypt(rawEncryptionKey), // encrypted at rest with the master key, like crmCredential
      status: STATUS.notAuthorized,
    });
  } else {
    if (crm.instanceUrl !== instanceUrl) {
      crm = (await updateCrm(crm.crmId, { instanceUrl })) ?? crm;
    }
    if (!crm.encryptionKey) {
      throw new Error('org_missing_encryption_key');
    }
    rawEncryptionKey = resolveOrgKey(crm.encryptionKey);
  }

  return { encryptionKey: rawEncryptionKey };
};

const authorizeUserHandler = async (userDetails: IAuthorizeUserPayload): Promise<{authorizationUrl: string}> => {
  // userDetails arrives here already plaintext: authorizationHandler decrypts
  // the whole request body (org_details + user_details together) with the
  // Bootstrap Key alone — there's no separate org-key layer on this route.
  const { user_id: crmUserId, org_id: orgId, user_email: userEmail, user_username: username, user_first_name: firstName, user_last_name: lastName, instance_url: instanceUrl, org_environment: environment, permission_set_name: permissionSetName } = userDetails;
  if (!crmUserId
    || !orgId
    || !instanceUrl
    || !userEmail || !username || !firstName || !lastName
    || !permissionSetName
  ) {
    throw new Error('Missing required field(s) in authorizeUserHandler payload');;
  }


  const existingUser = await getUserByCrmProfileUserId(crmUserId);
  if (existingUser) {
    await updateUser(
      { userId: existingUser.userId },
      { crmProfile: { ...existingUser.crmProfile, instanceUrl, organizationId: orgId, crmUserId } }
    );
  }

  const { url, codeVerifier, state } = getSalesforceLoginUrl(undefined, SALESFORCE_LOGIN_REDIRECT_URI, environment, instanceUrl);
  // Pin the state to this Salesforce user — the callback rejects the login if
  // someone else's credentials complete the OAuth flow. For a first-time admin
  // the user record is NOT created here: the profile rides along in the state
  // and the callback creates role + user only after Salesforce confirms the login.
  await createOAuthState(
    state,
    codeVerifier,
    crmUserId,
    'salesforce',
    environment,
    instanceUrl,
    firstName + ' ' + lastName,
    true,
    { username, email: userEmail, instanceUrl, organizationId: orgId, firstName, lastName, crmUserId, permissionSetName }
  );

  return { authorizationUrl: url };
};

export const authorizeController = wrapController({
  authorizationHandler
});
