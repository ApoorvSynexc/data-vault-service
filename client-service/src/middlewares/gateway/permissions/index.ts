import { archivalConfigPermissions } from "./archival-config";
import { archivalRecordPreviewPermissions } from "./archival-record-preview";
import { backupConfigPermissions } from "./backup-config";
import { backupJobPermissions } from "./backup-job";
import { destinationPermissions } from "./destination";
import { restorePermissions } from "./restore";
import { storagePermissions } from "./storage";

const aclGatewayPermissions = {
    "backup-config": backupConfigPermissions,
    "backup-job": backupJobPermissions,
    "archival-config": [...archivalConfigPermissions, ...archivalRecordPreviewPermissions],
    "restore": restorePermissions,
    "storage": storagePermissions,
    "destination": destinationPermissions
};

export { aclGatewayPermissions };