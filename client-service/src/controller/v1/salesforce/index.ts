import { defaultPermissions } from '../../../assets';
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { createUser, deleteUser, getUserByCrmProfileUserId, getUsersByCrmId, updateUser } from '../../../services/user';
import { createRole, deleteCrm, deleteRole, getBackupConfigsByUser, getCrmByOrgId, getRole, getRoles, getRolesByCrmId, updateRole, upsertCrm } from '../../../services';
import { ICrm, ICrmProfile, IRole, IRolePermissions } from '../../../models';
import { decrypt, decryptEnvelope, encryptEnvelope } from '../../../utils/encryption';
import { VISIBILITY_STATUS, SALESFORCE_ENCRYPTION_KEY } from '../../../constant';

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
  const { crm, data }: { crm: ICrm; data: any } = req.salesforcePayload;
  const orgKey = decrypt(crm.encryptionKey!);
  const { userId, modules, roleId } = data;

  if (!userId || !roleId) {
    res.status(400).json(encryptEnvelope({ errorCode: 'ID_REQUIRED' }, orgKey));
    return;
  }

  const existingUser = await getUserByCrmProfileUserId(userId, crm.organizationId);
  if (!existingUser) {
    res.status(404).json(encryptEnvelope({ errorCode: 'USER_NOT_FOUND' }, orgKey));
    return;
  }

  const updatedRole = await updateRole({ roleId: String(roleId) }, { permissions: modules ?? {} });
  if (!updatedRole) {
    res.status(404).json(encryptEnvelope({ errorCode: 'ROLE_NOT_FOUND' }, orgKey));
    return;
  }

  await updateUser(
    { userId: existingUser.userId },
    { role: { name: updatedRole.name, roleId: updatedRole.roleId } }
  );

  res.status(200).json(encryptEnvelope({ success: true }, orgKey));
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
        roleDescription: role.description ?? '',
        lastSyncDate: element.updatedAt ?? null,
      });
    }
  }

  // Wrapped under `users` — c/dvPermissionHandler's loadAll() reads
  // safeParseJson(usersRaw)?.users off the decrypted body.
  console.log(`[salesforce] getUsersHandler | users: ${JSON.stringify(users)}`);
  res.status(200).json(encryptEnvelope({ users }, decrypt(crm.encryptionKey!)));
};

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, data }: { crm: ICrm; data: any } = req.salesforcePayload;
  const orgKey = decrypt(crm.encryptionKey!);
  const { users, environment } = data;

  if (!users?.length) {
    res.status(400).json(encryptEnvelope({ errorCode: 'ID_REQUIRED' }, orgKey));
    return;
  }

  const result = [];
  for await (const user of users) {
    try {
      const { profile, role, ...rest } = user;
      const crmProfileUserId = profile.userId;
      const existingUser = await getUserByCrmProfileUserId(crmProfileUserId, crm.organizationId);
      console.log(`[salesforce] upsertUsersHandler | existingUser: ${JSON.stringify(existingUser)}`);

      const hasGrant = hasAnyGrant(role.permissions);
      console.log(`[salesforce] upsertUsersHandler | hasGrant: ${hasGrant} for user: ${JSON.stringify(user)}`);
      if (!hasGrant) {
        if (existingUser?.userId) {
          // check if user created any restore
          const backups = await getBackupConfigsByUser(existingUser?.userId);
          if (!backups?.length) {
            await deleteRole({ roleId: existingUser.role.roleId });
            await deleteUser(existingUser.userId);
            console.log(`[salesforce] upsertUsersHandler | user deleted: ${JSON.stringify(user)}`);
            result.push({ ...user, status: 'success', action: 'deleted' });
          } else {
            console.log(`[salesforce] upsertUsersHandler | user has backups, archival or restores: ${JSON.stringify(user)}`);
            result.push({ ...user, status: "failed", message: "user has backups, archival or restores" });
          }
        }
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
          console.log(`[salesforce] upsertUsersHandler | user updated: ${JSON.stringify(user)}`);
          result.push({ ...user, status: 'success', action: 'updated' });
          // If permission exist and if user not exist then create user and role
        } else {
          const roleName = 'Custom';
          const userId = uuidv4();
          const roleId = uuidv4();
          // attachDecryptedSalesforceRequest already resolved `crm` for this
          // org via the X-DataCraft-Org-Id header, so it's guaranteed to
          // exist here — no need to re-look it up by orgId.
          const { crmId } = crm;
          await createRole({ roleId, name: roleName, permissions: role.permissions });
          await createUser({ ...rest, crmProfile: profile, role: { name: roleName, roleId }, userId, crmId, isCrmConnected: false });
          await upsertCrm({
            userId,
            crmId,
            environment,
            organizationId: crm.organizationId,
            crmName: 'salesforce',
          });
          console.log(`[salesforce] upsertUsersHandler | user created: ${JSON.stringify(user)}`);
          result.push({ ...user, status: 'success', action: 'created' });
        }
      }
    } catch (error: any) {
      result.push({ ...user, status: 'failed', errorMessage: error.message });
    }
  }

  res.status(201).json(encryptEnvelope(result, orgKey));
};

const createRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, data }: { crm: ICrm; data: any } = req.salesforcePayload;
  const orgKey = decrypt(crm.encryptionKey!);
  const { crmId } = crm;
  // DataVaultPermissionService.createRole() (Apex) sends
  // { orgId, name, description, modules, createdBy } — `modules` on the wire
  // maps to IRole.permissions in storage. `createdBy` is derived server-side
  // in Apex from UserInfo.getName(), not user-entered.
  const { name, description, modules, createdBy } = data;

  // Role names must be unique within an org — case/whitespace-insensitive so
  // "Sales" and " sales " aren't treated as different roles.
  const existingRoles = await getRolesByCrmId(crmId);
  const nameTaken = existingRoles.some(
    (role) => role.name.trim().toLowerCase() === String(name).trim().toLowerCase()
  );
  if (nameTaken) {
    res.status(400).json(encryptEnvelope({ errorCode: 'ROLE_NAME_EXISTS' }, orgKey));
    return;
  }

  // A role with no module granted anything is not a usable role — every other
  // path that creates one (upsertUsersHandler) already treats "no grants" as
  // "delete/never-create the role", so reject it explicitly here too rather
  // than storing one nothing can ever pass hasAnyGrant() for.
  if (!hasAnyGrant(modules)) {
    res.status(400).json(encryptEnvelope({ errorCode: 'PERMISSIONS_REQUIRED' }, orgKey));
    return;
  }

  // req.salesforcePayload already required a registered CRM (with its own
  // encryption key) to decrypt this request at all, so crmId above is always
  // valid here — no need to look up or auto-create the CRM record separately.
  const roleId = uuidv4();
  await createRole({ roleId, crmId, name, description, permissions: modules ?? {}, createdBy });

  res.status(201).json(encryptEnvelope({ roleId }, orgKey));
};

const updateRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, data }: { crm: ICrm; data: any } = req.salesforcePayload;
  const orgKey = decrypt(crm.encryptionKey!);
  // DataVaultPermissionService.updateRole() (Apex) sends
  // { orgId, roleId, name, description, modules } — `modules` on the wire
  // maps to IRole.permissions in storage.
  const { roleId, name, description, modules } = data;

  const existingRole = await getRole({ roleId: String(roleId) });
  if (!existingRole) {
    res.status(404).json(encryptEnvelope({ errorCode: 'ROLE_NOT_FOUND' }, orgKey));
    return;
  }

  const updatedRole = await updateRole(
    { roleId: String(roleId) },
    {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(modules !== undefined && { permissions: modules }),
    }
  );

  res.status(200).json(encryptEnvelope(updatedRole, orgKey));
};

const deleteRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, data }: { crm: ICrm; data: any } = req.salesforcePayload;
  const orgKey = decrypt(crm.encryptionKey!);
  const { roleId } = data;

  if (!roleId) {
    res.status(400).json(encryptEnvelope({ errorCode: 'ID_REQUIRED' }, orgKey));
    return;
  }

  const deleted = await deleteRole({ roleId: String(roleId) });
  if (!deleted) {
    res.status(404).json(encryptEnvelope({ errorCode: 'ROLE_NOT_FOUND' }, orgKey));
    return;
  }

  res.status(200).json(encryptEnvelope({ success: true }, orgKey));
};

const confirmAdminUserCreatedHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { crm, data }: { crm: ICrm; data: any } = req.salesforcePayload;
  const orgKey = decrypt(crm.encryptionKey!);
  const { userId } = data;

  if (!userId) {
    res.status(400).json(encryptEnvelope({ errorCode: 'ID_REQUIRED' }, orgKey));
    return;
  }

  const existingUser = await getUserByCrmProfileUserId(userId, crm.organizationId);
  if (!existingUser) {
    res.status(404).json(encryptEnvelope({ errorCode: 'USER_NOT_FOUND' }, orgKey));
    return;
  }

  res.status(200).json(encryptEnvelope({ success: true }, orgKey));
};

// Bootstrap-only org existence check. This endpoint intentionally does not use
// attachDecryptedSalesforceRequest because Salesforce may not have the org key
// yet; the query envelope is decrypted only with SALESFORCE_ENCRYPTION_KEY
// (never ENCRYPTION_KEY, the at-rest storage key — see constant/index.ts).
const confirmOrgAuthorizedHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  let orgId: string | undefined;

  try {
    if (typeof req.query.envelope !== 'string') {
      throw new Error('invalid_wrapper');
    }

    const data = decryptEnvelope<{ orgId?: string }>(JSON.parse(req.query.envelope), SALESFORCE_ENCRYPTION_KEY);
    orgId = data.orgId;
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

  if (existingCrm.status !== VISIBILITY_STATUS.active) {
    makeResponse(req, res, 200, true, 'fetch', { success: false });
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
  res.status(200).json(encryptEnvelope({ roles: mappedRoles }, decrypt(crm.encryptionKey!)));
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
