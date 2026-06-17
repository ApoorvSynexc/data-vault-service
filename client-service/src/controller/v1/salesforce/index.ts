import { defaultPermissions } from '../../../assets';
import { IRequest, IResponse, makeResponse } from '../../../lib';
import { wrapController } from '../../../utils/helper';

const getPermissionsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const permissions = defaultPermissions;
  makeResponse(req, res, 200, true, 'fetch', permissions);
};

const upsertUsersHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const body = req.body;
  const { users } = body;

  if (!users?.length) {
    makeResponse(req, res, 400, false, 'id_required');
    return;
  }

  for await (const user of users) {
    const { profile, role, ...rest } = user;
    const organizationId = profile.organizationId;

    if(!role.permissions?.length) {
        // delete user
        // delete role
    } else {
      // Check user Exist
      if(true) {
        // update user
        // update role
      } else {
        // create user
        // create role
      }
    }
  }

  makeResponse(req, res, 201, true, 'update', body);
};

export const salesofrceController = wrapController({
  getPermissionsHandler,
  upsertUsersHandler
});
