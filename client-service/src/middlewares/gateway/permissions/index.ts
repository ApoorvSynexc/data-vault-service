import { archivalConfigPermissions } from "./archival-config";
import { backupConfigPermissions } from "./backup-config";
import { restorePermissions } from "./restore";

const aclGatewayPermissions = {
    "backup-config": backupConfigPermissions,
    "archival-config": archivalConfigPermissions,
    "restore": restorePermissions
};

export { aclGatewayPermissions };