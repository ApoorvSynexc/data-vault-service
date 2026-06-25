import { archivalConfigPermissions } from "./archival-config";
import { backupConfigPermissions } from "./backup-config";

const aclGatewayPermissions = {
    "backup-config": backupConfigPermissions,
    "archival-config": archivalConfigPermissions
};

export { aclGatewayPermissions };