import { defaultPermissions } from '../../../assets';
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { createUser, deleteUser, getUserByCrmProfileUserId, updateUser } from '../../../services/user';
import { createRole, deleteRole, getBackupConfigsByUser, getCrmByOrgId, updateRole, upsertCrm } from '../../../services';

interface ISalesforceProfile {
  orgId: string;
  instanceUrl: string;
  userId: string;
  username: string;
  email: string;
  photoUrl?: string;
}

interface IRole {
  permissions: string[];
}

interface ISalesforceUser {
  firstName: string;
  lastName: string;
  profile: ISalesforceProfile;
  role: IRole;
}

interface IUpsertUsersRequest {
  users: ISalesforceUser[];
}

const getPermissionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const permissions = defaultPermissions;
  makeResponse(req, res, 200, true, 'fetch', permissions);
};

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const body = req.body as IUpsertUsersRequest;
  const { users } = body;

  if (!users?.length) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  const result = [];
  for await (const user of users) {
    try {
      const { profile, role, ...rest } = user;
      const crmProfileUserId = profile.userId;
      const orgId = profile.orgId;
      const existingUser = await getUserByCrmProfileUserId(crmProfileUserId);

      //If permission not exist, then clean up user and role
      if (!role.permissions?.length) {
        if (existingUser?.userId) {
          // check if user created any restore
          const backups = await getBackupConfigsByUser(existingUser?.userId);
          if (!backups?.length) {
            await deleteRole({ roleId: existingUser.role.roleId });
            await deleteUser(existingUser.userId);
          }
        }
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
          // If permission exist and if user not exist then create user and role
        } else {
          const roleName = 'Custom';
          const userId = uuidv4();
          const roleId = uuidv4();
          const crmExist = await getCrmByOrgId(orgId);
          await createRole({ roleId, name: roleName, permissions: role.permissions });
          await createUser({ ...rest, profile, role: { name: roleName, roleId } });
          await upsertCrm({
            userId,
            crmId: crmExist ? crmExist.crmId : undefined,
            organizationId: orgId,
            crmName: 'salesforce',
          });
        }
      }
      result.push({ ...user, staus: 'success' });
    } catch (error: any) {
      result.push({ ...user, staus: 'failed', errorMessage: error.message });
    }
  }

  makeResponse(req, res, 201, true, 'update', result);
};

export const salesofrceController = wrapController({
  getPermissionsHandler,
  upsertUsersHandler,
});
