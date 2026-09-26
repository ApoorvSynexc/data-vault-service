import { logger } from "../middlewares";
import { getCrmById, getUsersInBatches, refreashSalesforceToken, updateUser } from "../services";
import { decrypt, encrypt, EncryptedPayload } from "../utils/encryption";

const runSyncSalesforceRefreshTokenJob = async () => {
    try {
        await getUsersInBatches(async (users) => {
            for (const user of users) {
                if (!user.crmCredential || !user.crmId) continue;

                try {
                    const { refresh_token } = JSON.parse(decrypt(user.crmCredential as EncryptedPayload)) as { access_token: string; refresh_token: string };
                    if (!refresh_token) continue;

                    const crm = await getCrmById(user.crmId);
                    const refreshed = await refreashSalesforceToken(refresh_token, crm?.environment, user.customUrl);

                    const crmCredential = {
                        access_token: refreshed.access_token,
                        refresh_token: refreshed.refresh_token || refresh_token,
                    };
                    await updateUser({ userId: user.userId }, { crmCredential: encrypt(JSON.stringify(crmCredential)) });

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
