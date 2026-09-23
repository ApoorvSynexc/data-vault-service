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
  createPaymentAccount,
  setupPayment,
  getUser,
} from '../../../services';
import { encrypt, decrypt, decryptEnvelope, encryptEnvelope, generateOrgEncryptionKey } from '../../../utils/encryption';
import { STATUS, SALESFORCE_LOGIN_REDIRECT_URI } from '../../../constant';
import { logger } from '../../../middlewares';

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

    let payload: { type?: string; user_details?: IAuthorizeUserPayload; org_details?: IAuthorizeOrganizationPayload };
    try {
      payload = decryptEnvelope<{ type?: string; user_details?: IAuthorizeUserPayload; org_details?: IAuthorizeOrganizationPayload }>(req.body);
    } catch (error: any) {
      logger.warn(`[configure-org] 401: decrypt/envelope failed: ${error?.message ?? error}`);
      makeResponse(req, res, 401, false, 'unauthorized');
      return;
    }
    const finalResponse: any = {};
    if (payload.type === 'org' && payload.org_details && payload.user_details) {
      finalResponse.org = await authorizeOrgHandler(payload.org_details);
      const crm = finalResponse.org ? await getCrmByOrgId(payload.org_details.orgId) : null;
      if (!crm) {
        logger.warn(`[configure-org] 401: org not registered for user authorization: ${payload.org_details.orgId}`);
        throw new Error('Org not registered for user authorization');
      }
      finalResponse.user = encryptEnvelope(await authorizeUserHandler(payload.user_details), decrypt(crm.encryptionKey!));

      // if (!crm.paymentToken) {
      //   const account = await createPaymentAccount(crm.organizationId, payload.user_details.user_id);
      //   const setup = await setupPayment({
      //     orgId: crm.organizationId,
      //     token: account.token,
      //     sfSecret: account.sf_secret,
      //     orgInfo: {
      //       OrgType: crm.environment === 'production' ? 'Production' : 'Sandbox',
      //       orgName: '360SMS',
      //       email: payload.user_details.user_email || '',
      //       userName: payload.user_details.user_username || '',
      //     },
      //     isTokenEncrypted: false
      //   });

      //   const paymentToken = encrypt(JSON.stringify({
      //     sf_secret: account.sf_secret,
      //     token: setup.token
      //   }));
      //   const paymentDetail = setup.data?.Success;
      //   await updateCrm(crm.crmId, { paymentToken, paymentDetail });
      // }
    }

    makeResponse(req, res, 200, true, 'fetch', encryptEnvelope(finalResponse));
  } catch (error) {
    logger.error(`Error in authorizeOrganizationHandler: ${error}`);
    console.log(`STACK TRACE: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
    makeResponse(req, res, 500, false, 'unknown_error');
  }
};


const authorizeOrgHandler = async (payload: IAuthorizeOrganizationPayload): Promise<{ encryptionKey: string; apiKey: string }> => {
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
  // middlewares/salesforce/index.ts) once an org key exists.
  const { orgId, instanceUrl } = payload;
  if (!orgId || !instanceUrl) {
    logger.warn(`[configure-org] 401: missing required field(s): hasOrgId=${!!orgId} hasInstanceUrl=${!!instanceUrl}`);
    throw new Error('Missing required field(s) in authorizeOrgHandler payload');
  }

  let crm = await getCrmByOrgId(orgId);
  let rawEncryptionKey: string;
  let rawApiKey: string;

  if (!crm) {
    rawEncryptionKey = generateOrgEncryptionKey();
    // Same random-secret generator as the encryption key — it's just
    // crypto.randomBytes(32), which is exactly what a per-org API key needs too.
    rawApiKey = generateOrgEncryptionKey();
    crm = await upsertCrm({
      crmId: uuidv4(),
      organizationId: orgId,
      crmName: 'salesforce',
      instanceUrl,
      encryptionKey: encrypt(rawEncryptionKey), // encrypted at rest with the master key, like crmCredential
      apiKey: encrypt(rawApiKey),
      status: STATUS.inactive,
    });
  } else {
    if (crm.instanceUrl !== instanceUrl) {
      crm = (await updateCrm(crm.crmId, { instanceUrl })) ?? crm;
    }
    if (!crm.encryptionKey || !crm.apiKey) {
      throw new Error('org_missing_encryption_key');
    }
    rawEncryptionKey = decrypt(crm.encryptionKey);
    rawApiKey = decrypt(crm.apiKey);
  }

  return { encryptionKey: rawEncryptionKey, apiKey: rawApiKey };
};

const authorizeUserHandler = async (userDetails: IAuthorizeUserPayload): Promise<{ authorizationUrl: string }> => {
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


  const existingUser = await getUserByCrmProfileUserId(crmUserId, orgId);
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
