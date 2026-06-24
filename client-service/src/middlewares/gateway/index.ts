import { NextFunction } from "express";
import { IRequest, IResponse, makeResponse } from "../../lib";
import { getRole } from "../../services";
import { aclGatewayPermissions } from "./permissions";

type IAclGatewayPermissions = keyof typeof aclGatewayPermissions;

const aclGateway = async (req: IRequest, res: IResponse, next: NextFunction): Promise<void> => {
    try {
        const allowedModules = ["user", "crm", "/backup-job", "dashboard", "destination"];
        const requestaPath = req.path;
        const requestMethod = req.method;
        const user = req.user;
        if (!user) {
            return makeResponse(req, res, 401, false, 'unauthorized');
        }

        const role = await getRole({ roleId: user.role.roleId });
        if (!role || !role.permissions || !role.permissions.length) {
            return makeResponse(req, res, 401, false, 'unauthorized');
        }

        const submodule = requestaPath.split('/')[1] as IAclGatewayPermissions;
        if (!allowedModules.includes(submodule)) {
            const modulePermissions = aclGatewayPermissions[submodule];
            if (!modulePermissions) {
                return makeResponse(req, res, 403, false, 'insufficient_permission');
            }

            const hasPermission = modulePermissions.some(({ path, method, permissions }) => path === requestaPath && method === requestMethod && permissions.some((permission) => (role.permissions && role.permissions.includes(permission))));
            if (!hasPermission) {
                return makeResponse(req, res, 403, false, 'insufficient_permission');
            }
        }

        next();
    } catch (error) {
        console.log('Permission Gateway Error', error);
        return makeResponse(req, res, 401, false, 'unauthorized');
    }
}

export { aclGateway };