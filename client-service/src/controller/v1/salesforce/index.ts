import { defaultPermissions } from '../../../assets';
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { createUser, deleteUser, getUserByCrmProfileUserId, getUsersByCrmId, updateUser } from '../../../services/user';
import { createRole, deleteCrm, deleteRole, getBackupConfigsByUser, getCrmByOrgId, getRole, getRoles, getRolesByCrmId, updateRole, upsertCrm } from '../../../services';
import { ICrmProfile, IRole, IUser } from '../../../models';

interface IUpsertUsersRequest {
  organizationId: string;
  users: Array<{
    firstName: string;
    lastName: string;
    profile: ICrmProfile;
    role: IRole;
  }>
}

const getPermissionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const permissions = defaultPermissions;
  makeResponse(req, res, 200, true, 'fetch', permissions);
};

const getUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { organizationId } = req.query;
  const crm = await getCrmByOrgId(String(organizationId));
  if (!crm) {
    return makeResponse(req, res, 404, false, 'not_exist');
  }

  const usersByCrmId = await getUsersByCrmId(crm.crmId);
  const filteredUsers: IUser[] = [];
  for await (const element of usersByCrmId) {
    const role = await getRole({ roleId: element.role.roleId });
    if (role?.permissions?.length) {
      filteredUsers.push({ ...element, role: { ...element.role, permissions: role.permissions } });
    }
  }
  makeResponse(req, res, 200, true, 'fetch', filteredUsers);
};

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const body = req.body as IUpsertUsersRequest;
  const { users, organizationId } = body;

  if (!users?.length) {
    makeResponse(req, res, 400, false, 'id_required');
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
      if (!role.permissions?.length) {
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
              profile: { ...existingUser.profile, ...profile },
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
          await createUser({ ...rest, crmProfile: profile, role: { name: roleName, roleId }, crmId });
          await upsertCrm({
            userId,
            crmId,
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

  // If all user and role delete from db then delete crm
  if (organizationId) {
    const crm = await getCrmByOrgId(organizationId);
    if (crm) {
      const usersByCrmId = await getUsersByCrmId(crm.crmId);
      if (!usersByCrmId.length) {
        await deleteCrm(crm.crmId);
      }
    }
  }

  console.log(JSON.stringify({ result }));
  makeResponse(req, res, 201, true, 'update', result);
};

const createRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { organizationId, ...body } = req.body;

  let crm = await getCrmByOrgId(String(organizationId));
  if (!crm) {
    return makeResponse(req, res, 404, false, 'not_exist');
  }

  const roleId = uuidv4();
  await createRole({
    roleId,
    ...body
  });

  makeResponse(req, res, 201, true, 'create', { roleId });
};

const updateRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { roleId, ...body } = req.body;

  const existingRole = await getRole({ roleId: String(roleId) });
  if (!existingRole) {
    return makeResponse(req, res, 404, false, 'not_exist');
  }

  const updatedRole = await updateRole(
    { roleId: String(roleId) },
    body
  );

  makeResponse(req, res, 200, true, 'update', updatedRole);
};

const deleteRoleHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { roleId } = req.query;

  if (!roleId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const deleted = await deleteRole({ roleId: String(roleId) });
  if (!deleted) {
    return makeResponse(req, res, 404, false, 'not_exist');
  }

  makeResponse(req, res, 200, true, 'delete');
};

const getRolesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { organizationId } = req.query;

  if (!organizationId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const crm = await getCrmByOrgId(String(organizationId));
  if (!crm) {
    return makeResponse(req, res, 404, false, 'not_exist');
  }

  const roles = await getRolesByCrmId(crm.crmId);
  makeResponse(req, res, 200, true, 'fetch', roles);
};

export const salesofrceController = wrapController({
  getPermissionsHandler,
  upsertUsersHandler,
  getUsersHandler,
  createRoleHandler,
  updateRoleHandler,
  deleteRoleHandler,
  getRolesHandler,
});
