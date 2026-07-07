import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import {
  getCrmByOrgId,
  upsertCrm,
  updateCrm,
  getUserByCrmProfileUserId,
  createUser,
  updateUser,
  createOAuthState,
  getSalesforceLoginUrl,
} from '../../../services';
import { decrypt, generateOrgEncryptionKey, readEnvelope } from '../../../utils/encryption';
import { encryptSalesforceResponse } from '../../../utils/salesforce-crypto';
import { STATUS, ENCRYPTION_KEY, SALESFORCE_LOGIN_REDIRECT_URI } from '../../../constant';
import { defaultRoles } from '../../../assets';
import { ICrm } from '../../../models';

const authorizeOrganizationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
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
  console.log('[authorize-org] incoming body:', JSON.stringify(req.body));
  console.log('[authorize-org] decrypting with master ENCRYPTION_KEY (bootstrap key):', ENCRYPTION_KEY);

  let plaintext: string;
  try {
    plaintext = decrypt(readEnvelope(req.body));
  } catch (error: any) {
    console.log('[authorize-org] 401: decrypt/envelope failed:', error?.message ?? error);
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  let payload: { orgId?: string; instanceUrl?: string };
  try {
    payload = JSON.parse(plaintext);
    console.log('[authorize-org] decrypted payload:', JSON.stringify(payload));
  } catch (error: any) {
    console.log('[authorize-org] 401: decrypted plaintext is not valid JSON:', plaintext, error?.message ?? error);
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  const { orgId, instanceUrl } = payload;
  if (!orgId || !instanceUrl) {
    console.log('[authorize-org] 401: missing required field(s):', {
      hasOrgId: !!orgId,
      hasInstanceUrl: !!instanceUrl,
    });
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  let crm = await getCrmByOrgId(orgId);

  if (!crm) {
    const encryptionKey = generateOrgEncryptionKey();
    console.log('[authorize-org] new org — generated per-org encryption key:', encryptionKey);
    crm = await upsertCrm({
      crmId: uuidv4(),
      organizationId: orgId,
      crmName: 'salesforce',
      instanceUrl,
      encryptionKey,
      status: STATUS.notAuthorized,
    });
  } else if (crm.instanceUrl !== instanceUrl) {
    crm = (await updateCrm(crm.crmId, { instanceUrl })) ?? crm;
  }

  console.log('[authorize-org] returning encryption key to Salesforce for org', orgId, ':', crm.encryptionKey);
  res.status(200).json({ success: true, encryptionKey: crm.encryptionKey });
};

const authorizeUserHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  // By the time requestAuthorizationUrl() runs (always after authorizeOrganization()
  // in the LWC's single-click flow), Salesforce has an org key and encrypts this
  // request two-layer: Bootstrap Key wraps { orgId, org-key-encrypted payload }.
  // The shared middleware (attachDecryptedSalesforceRequest) has already unwrapped
  // both layers before this handler runs.
  const { orgId, crm, plaintext }: { orgId: string; crm: ICrm; plaintext: string } = req.salesforcePayload;

  let payload: { current_user_id?: string; org_id?: string; instance_url?: string };
  try {
    payload = JSON.parse(plaintext);
  } catch (error: any) {
    console.log('[authorize-admin] 401: decrypted plaintext is not valid JSON:', plaintext, error?.message ?? error);
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  const { current_user_id: userId, org_id: innerOrgId, instance_url: instanceUrl } = payload;
  if (!userId || !innerOrgId || !instanceUrl) {
    console.log('[authorize-admin] 401: missing required field(s):', {
      hasUserId: !!userId,
      hasOrgId: !!innerOrgId,
      hasInstanceUrl: !!instanceUrl,
    });
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  if (innerOrgId !== orgId) {
    console.log('[authorize-admin] 401: inner org_id does not match outer wrapper orgId:', { innerOrgId, orgId });
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  const existingUser = await getUserByCrmProfileUserId(userId);
  if (existingUser) {
    await updateUser(
      { userId: existingUser.userId },
      { crmProfile: { ...existingUser.crmProfile, instanceUrl, organizationId: orgId, userId } }
    );
  } else {
    const adminRole = defaultRoles.find((r) => r.name === 'Admin');
    await createUser({
      userId: uuidv4(),
      crmId: crm.crmId,
      crmProfile: { instanceUrl, organizationId: orgId, userId },
      ...(adminRole && { role: { name: adminRole.name, roleId: adminRole.roleId } }),
    });
  }


  const { url, codeVerifier, state } = getSalesforceLoginUrl(undefined, SALESFORCE_LOGIN_REDIRECT_URI, crm.environment, instanceUrl);
  await createOAuthState(state, codeVerifier, '', 'salesforce', crm.environment, instanceUrl);

  res.status(200).json(encryptSalesforceResponse(crm, { authorizationUrl: url }));
};

export const authorizeController = wrapController({
  authorizeOrganizationHandler,
  authorizeUserHandler,
});
