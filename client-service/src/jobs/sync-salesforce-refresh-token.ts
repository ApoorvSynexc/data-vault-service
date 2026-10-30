import { logger } from "../middlewares";
import { getFreshTokens, getUsersInBatches } from "../services";
import { SALESFORCE_TOKEN_STATUS, TOKEN_REFRESH_TRIGGER } from "../constant";
import { timer } from "../utils/helper";

// Keeps idle orgs' refresh tokens alive. Users refreshed recently, mid-refresh,
// or not Ready are skipped — TokenAuthority / the retry worker own those.
const RECENT_REFRESH_SKIP_MS = 12 * 60 * 60 * 1000;
const DELAY_BETWEEN_USERS_MS = 200;

const runSyncSalesforceRefreshTokenJob = async () => {
    try {
        await getUsersInBatches(async (users) => {
            for (const user of users) {
                if (!user.crmCredential || !user.crmId) continue;
                if ((user.tokenStatus ?? SALESFORCE_TOKEN_STATUS.ready) !== SALESFORCE_TOKEN_STATUS.ready) continue;
                if (user.refreshLockedUntil && user.refreshLockedUntil > Date.now()) continue;
                if (user.lastRefreshAt && Date.now() - Date.parse(user.lastRefreshAt) < RECENT_REFRESH_SKIP_MS) continue;

                try {
                    await getFreshTokens(user.userId, { trigger: TOKEN_REFRESH_TRIGGER.nightly });
                    logger.info(`[salesforce refresh token sync - CRON] user ${user.userId} synced successfully`);
                } catch (error) {
                    logger.error(`[salesforce refresh token sync - CRON] user ${user.userId} threw error: ${(error as Error)?.message ?? String(error)}`);
                }
                await timer(DELAY_BETWEEN_USERS_MS);
            }
        });
    } catch (error) {
        logger.error(`[salesforce refresh token sync - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    }
};

export {
    runSyncSalesforceRefreshTokenJob
};
