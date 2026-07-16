import { archivalConfigPermissions } from "./archival-config";
import { backupConfigPermissions } from "./backup-config";
import { restorePermissions } from "./restore";
import { storagePermissions } from "./storage";

const aclGatewayPermissions = {
    "backup-config": backupConfigPermissions,
    "archival-config": archivalConfigPermissions,
    "restore": restorePermissions,
    "storage": storagePermissions
};

export { aclGatewayPermissions };