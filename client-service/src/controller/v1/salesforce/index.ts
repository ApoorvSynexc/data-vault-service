import { defaultPermissions } from '../../../assets';
import { v4 as uuidv4 } from 'uuid';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';
import { createUser, getUserByCrmProfileUserId } from '../../../services/user';
import { createRole, getCrmByOrgId, upsertCrm } from '../../../services';

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

  for await (const user of users) {
    const { profile, role, ...rest } = user;
    const crmProfileUserId = profile.userId;
    const orgId = profile.orgId;

    if (!role.permissions?.length) {
      // delete user
      // delete role
    } else {
      const existingUser = await getUserByCrmProfileUserId(crmProfileUserId);
      if (existingUser) {
        // update user
        // update role
      } else {
        // Check Crm is exist
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
  }

  makeResponse(req, res, 201, true, 'update', body);
};

export const salesofrceController = wrapController({
  getPermissionsHandler,
  upsertUsersHandler,
});
