import { logger } from "../middlewares";
import { getCrmById, getUsersInBatches, refreshAndPersistSalesforceToken } from "../services";
import { decrypt, EncryptedPayload } from "../utils/encryption";

const runSyncSalesforceRefreshTokenJob = async () => {
    try {
        await getUsersInBatches(async (users) => {
            for (const user of users) {
                if (!user.crmCredential || !user.crmId) continue;

                try {
                    const { refresh_token } = JSON.parse(decrypt(user.crmCredential as EncryptedPayload)) as { access_token: string; refresh_token: string };
                    if (!refresh_token) continue;

                    const crm = await getCrmById(user.crmId);
                    await refreshAndPersistSalesforceToken(user.userId, refresh_token, crm?.environment, user.customUrl);

                    logger.info(`[salesforce refresh token sync - CRON] user ${user.userId} synced successfully`);
                } catch (error) {
                    logger.error(`[salesforce refresh token sync - CRON] user ${user.userId} threw error: ${(error as Error)?.message ?? String(error)}`);
                }
            }
        });
    } catch (error) {
        logger.error(`[salesforce refresh token sync - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    }
};

export {
    runSyncSalesforceRefreshTokenJob
};
