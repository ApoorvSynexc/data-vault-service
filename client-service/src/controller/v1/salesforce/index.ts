import { defaultPermissions } from '../../../assets';
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { createUser, deleteUser, getUserByCrmProfileUserId, getUsersByCrmId, updateUser } from '../../../services/user';
import { createRole, deleteCrm, deleteRole, getBackupConfigsByUser, getCrmByOrgId, getRole, getRoles, getRolesByCrmId, updateRole, upsertCrm } from '../../../services';
import { ICrm, ICrmProfile, IRole, IRolePermissions } from '../../../models';
import { decrypt, readEnvelope } from '../../../utils/encryption';
import { encryptSalesforceResponse } from '../../../utils/salesforce-crypto';

// A role "has access" once any module has at least one granted action —
// mirrors hasAnyAccess() in the reference UI design.
const hasAnyGrant = (permissions?: IRolePermissions): boolean =>
  Object.values(permissions ?? {}).some((actions) => actions.length > 0);

interface IUpsertUsersRequest {
  organizationId: string;
  environment?: 'production' | 'sandbox';
  users: Array<{
    firstName: string;
    lastName: string;
    profile: ICrmProfile;
    role: IRole;
  }>
}

// Unlike every other salesforce/* handler, this endpoint is unauthenticated and
// unencrypted (see route wiring) — it's a static module catalog, not org data.
// Apex's getSourcingPermissions() returns this response body untouched to the
// LWC, which reads `.modules` at the top level, so this bypasses makeResponse's
// {success,message,data,meta} envelope.
//
// Full nested shape (module -> its own action set), not just module keys —
// the permission matrix UI renders per-module actions (e.g. Backup has
// View/Config/Execute/Delete, Dashboard has View only) and must not assume
// uniform CRUD across modules.
const getPermissionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const modules = defaultPermissions.map((module) => ({
    key: module.value,
    label: module.label,
    description: module.description,
    actions: module.permissions.map((action) => ({
      key: action.value,
      label: action.label,
      description: action.description,
      risky: action.risky ?? false,
    })),
  }));
  res.status(200).json({ modules });
};

// Reassigns a user to a role and updates that role's permission set in one
// call — mirrors the LWC's per-user permissions editor, which lets an admin
// pick a role and customize its modules from a single screen.
const updatePermissionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, plaintext }: { crm: ICrm; plaintext: string } = req.salesforcePayload;
  const { userId, modules, roleId } = JSON.parse(plaintext);

  if (!userId || !roleId) {
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'ID_REQUIRED' }));
    return;
  }

  const existingUser = await getUserByCrmProfileUserId(userId);
  if (!existingUser) {
    res.status(404).json(encryptSalesforceResponse(crm, { errorCode: 'USER_NOT_FOUND' }));
    return;
  }

  const updatedRole = await updateRole({ roleId: String(roleId) }, { permissions: modules ?? {} });
  if (!updatedRole) {
    res.status(404).json(encryptSalesforceResponse(crm, { errorCode: 'ROLE_NOT_FOUND' }));
    return;
  }

  await updateUser(
    { userId: existingUser.userId },
    { role: { name: updatedRole.name, roleId: updatedRole.roleId } }
  );

  res.status(200).json(encryptSalesforceResponse(crm, { success: true }));
};

const getUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm }: { crm: ICrm } = req.salesforcePayload;
  const { crmId } = crm;

  const usersByCrmId = await getUsersByCrmId(crmId);
  const users = [];
  for await (const element of usersByCrmId) {
    const role = await getRole({ roleId: element.role.roleId });
    if (role && hasAnyGrant(role.permissions)) {
      // Flat shape expected by the LWC's mapUserPermission()/mergeApiPermissions()
      // (c/dvPermissionService): userId must be the Salesforce user id — the same
      // id mergeApiPermissions() joins against sfUser.Id — not our internal userId.
      users.push({
        userId: element.crmProfile?.userId,
        name: [element.firstName, element.lastName].filter(Boolean).join(' '),
        email: element.crmProfile?.email ?? element.contactEmail,
        modules: role.permissions,
        roleId: role.roleId,
        roleName: role.name,
        lastSyncDate: element.updatedAt ?? null,
      });
    }
  }
  // Wrapped under `users` — c/dvPermissionHandler's loadAll() reads
  // safeParseJson(usersRaw)?.users off the decrypted body.
  res.status(200).json(encryptSalesforceResponse(crm, { users }));
};

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, plaintext }: { crm: ICrm; plaintext: string } = req.salesforcePayload;
  const decryptedBody = JSON.parse(plaintext);
  const { users, environment, organizationId } = decryptedBody;

  if (!users?.length) {
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'ID_REQUIRED' }));
    return;
  }

  const result = [];
  for await (const user of users) {
    try {
      const { profile, role, ...rest } = user;
      const crmProfileUserId = profile.userId;
      const orgId = profile.organizationId;
      const existingUser = await getUserByCrmProfileUserId(crmProfileUserId);

      //If permission not exist, then clean up user and role
      if (!hasAnyGrant(role.permissions)) {
        if (existingUser?.userId) {
          // check if user created any restore
          const backups = await getBackupConfigsByUser(existingUser?.userId);
          if (!backups?.length) {
            await deleteRole({ roleId: existingUser.role.roleId });
            await deleteUser(existingUser.userId);
          } else {
            result.push({ ...user, status: "failed", message: "user has backups, archival or restores" });
          }
        }

        result.push({ ...user, staus: 'success', action: 'deleted' });
      } else {
        // If permission exist and if User exist then update user and role
        if (existingUser) {
          await updateUser(
            { userId: existingUser.userId },
            {
              userId: existingUser.userId,
              crmProfile: { ...existingUser.profile, ...profile },
            });
          await updateRole(
            { roleId: existingUser.role.roleId },
            { permissions: role.permissions }
          )
          result.push({ ...user, staus: 'success', action: 'updated' });
          // If permission exist and if user not exist then create user and role
        } else {
          const roleName = 'Custom';
          const userId = uuidv4();
          const roleId = uuidv4();
          let crmId = uuidv4();
          const crmExist = await getCrmByOrgId(orgId);
          if (crmExist) {
            crmId = crmExist.crmId
          }
          await createRole({ roleId, name: roleName, permissions: role.permissions });
          await createUser({ ...rest, crmProfile: profile, role: { name: roleName, roleId }, userId, crmId, isCrmConnected: false });
          await upsertCrm({
            userId,
            crmId,
            environment,
            organizationId: orgId,
            crmName: 'salesforce',
          });
          result.push({ ...user, staus: 'success', action: 'created' });
        }
      }
    } catch (error: any) {
      result.push({ ...user, staus: 'failed', errorMessage: error.message });
    }
  }

  // // If all user and role delete from db then delete crm
  // if (organizationId) {
  //   const crm = await getCrmByOrgId(organizationId);
  //   if (crm) {
  //     const usersByCrmId = await getUsersByCrmId(crm.crmId);
  //     if (!usersByCrmId.length) {
  //       await deleteCrm(crm.crmId);
  //     }
  //   }
  // }

  res.status(201).json(encryptSalesforceResponse(crm, result));
};

const createRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, plaintext }: { crm: ICrm; plaintext: string } = req.salesforcePayload;
  const { crmId } = crm;
  // DataVaultPermissionService.createRole() (Apex) sends { orgId, name, modules, createdBy }
  // — `modules` on the wire maps to IRole.permissions in storage. `createdBy` is
  // derived server-side in Apex from UserInfo.getName(), not user-entered.
  const { name, modules, createdBy } = JSON.parse(plaintext);

  // req.salesforcePayload already required a registered CRM (with its own
  // encryption key) to decrypt this request at all, so crmId above is always
  // valid here — no need to look up or auto-create the CRM record separately.
  const roleId = uuidv4();
  await createRole({ roleId, crmId, name, permissions: modules ?? {}, createdBy });

  res.status(201).json(encryptSalesforceResponse(crm, { roleId }));
};

const updateRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, plaintext }: { crm: ICrm; plaintext: string } = req.salesforcePayload;
  // DataVaultPermissionService.updateRole() (Apex) sends { orgId, roleId, name, modules }
  // — `modules` on the wire maps to IRole.permissions in storage.
  const { roleId, name, modules } = JSON.parse(plaintext);

  const existingRole = await getRole({ roleId: String(roleId) });
  if (!existingRole) {
    res.status(404).json(encryptSalesforceResponse(crm, { errorCode: 'ROLE_NOT_FOUND' }));
    return;
  }

  const updatedRole = await updateRole(
    { roleId: String(roleId) },
    {
      ...(name !== undefined && { name }),
      ...(modules !== undefined && { permissions: modules }),
    }
  );

  res.status(200).json(encryptSalesforceResponse(crm, updatedRole));
};

const deleteRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, plaintext }: { crm: ICrm; plaintext: string } = req.salesforcePayload;
  const { roleId } = JSON.parse(plaintext);

  if (!roleId) {
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'ID_REQUIRED' }));
    return;
  }

  const deleted = await deleteRole({ roleId: String(roleId) });
  if (!deleted) {
    res.status(404).json(encryptSalesforceResponse(crm, { errorCode: 'ROLE_NOT_FOUND' }));
    return;
  }

  res.status(200).json(encryptSalesforceResponse(crm, { success: true }));
};

const confirmAdminUserCreatedHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, plaintext }: { crm: ICrm; plaintext: string } = req.salesforcePayload;
  const { userId } = JSON.parse(plaintext);

  if (!userId) {
    res.status(400).json(encryptSalesforceResponse(crm, { errorCode: 'ID_REQUIRED' }));
    return;
  }

  const existingUser = await getUserByCrmProfileUserId(userId);
  if (!existingUser) {
    res.status(404).json(encryptSalesforceResponse(crm, { errorCode: 'USER_NOT_FOUND' }));
    return;
  }

  // If need update the CRM Table
  // const crm = await getCrmByOrgId(existingUser.crmProfile?.organizationId ?? '');
  // if (!crm) {
  //   res.status(404).json(encryptSalesforceResponse(crm, { errorCode: 'CRM_NOT_FOUND' }));
  //   return;
  // }

  res.status(200).json(encryptSalesforceResponse(crm, { success: true }));
};

// Bootstrap-only org existence check. This endpoint intentionally does not use
// attachDecryptedSalesforceRequest because Salesforce may not have the org key
// yet; the query envelope is decrypted only with ENCRYPTION_KEY.
const confirmOrgAuthorizedHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  let orgId: string | undefined;

  try {
    if (typeof req.query.envelope !== 'string') {
      throw new Error('invalid_wrapper');
    }

    const plaintext = decrypt(readEnvelope(JSON.parse(req.query.envelope)));
    orgId = JSON.parse(plaintext).orgId;
  } catch {
    makeResponse(req, res, 401, false, 'unauthorized');
    return;
  }

  if (!orgId) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const existingCrm = await getCrmByOrgId(orgId);
  if (!existingCrm) {
    makeResponse(req, res, 404, false, 'crm_not_found');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', { success: true });
};


const getRolesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm }: { crm: ICrm } = req.salesforcePayload;

  const roles = await getRolesByCrmId(crm.crmId);
  // Wrapped under `roles`, and `permissions` renamed to `modules` on the wire —
  // c/dvRolesHandler's loadAll() and c/dvPermissionService's mapRole() both
  // expect { roles: [{ roleId, name, description, modules, createdBy, modifiedDate }] }.
  const mappedRoles = roles.map((role) => ({
    roleId: role.roleId,
    name: role.name,
    description: role.description ?? '',
    modules: role.permissions ?? {},
    createdBy: role.createdBy ?? null,
    modifiedDate: role.updatedAt ?? null,
  }));
  res.status(200).json(encryptSalesforceResponse(crm, { roles: mappedRoles }));
};

export const salesofrceController = wrapController({
  getPermissionsHandler,
  updatePermissionsHandler,
  upsertUsersHandler,
  getUsersHandler,
  createRoleHandler,
  updateRoleHandler,
  deleteRoleHandler,
  getRolesHandler,
  confirmAdminUserCreatedHandler,
  confirmOrgAuthorizedHandler
});
