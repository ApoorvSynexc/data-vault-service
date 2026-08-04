import { startBackupConfigCron } from "./backup-config-cron"

export const startCron = () => {
    startBackupConfigCron();
}