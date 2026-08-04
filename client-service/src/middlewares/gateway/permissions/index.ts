import { archivalConfigPermissions } from "./archival-config";
import { backupConfigPermissions } from "./backup-config";
import { backupJobPermissions } from "./backup-job";
import { restorePermissions } from "./restore";
import { storagePermissions } from "./storage";

const aclGatewayPermissions = {
    "backup-config": backupConfigPermissions,
    "backup-job": backupJobPermissions,
    "archival-config": archivalConfigPermissions,
    "restore": restorePermissions,
    "storage": storagePermissions
};

export { aclGatewayPermissions };