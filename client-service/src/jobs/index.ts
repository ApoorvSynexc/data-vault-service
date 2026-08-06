import { startBackupConfigCron } from "./backup-config-cron"
import { startLogsArchiveCron } from "./logs-archive-cron"

export const startCron = () => {
    startBackupConfigCron();
    startLogsArchiveCron();
}