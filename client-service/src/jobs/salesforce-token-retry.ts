import { logger } from "../middlewares";
import { getFreshTokens, getUser } from "../services";
import { SALESFORCE_TOKEN_STATUS, TOKEN_REFRESH_TRIGGER } from "../constant";

// P6 — durable Salesforce token retry, fired by the one-time EventBridge
// schedule TokenAuthority creates on RetryScheduled. A duplicate or late
// delivery (attempt no longer current, or already resolved) is ignored.
// Success / next attempt / terminal status are all handled by TokenAuthority
// and token-lifecycle.ts.
const runSalesforceTokenRetry = async (params: { userId: string; attempt: number }) => {
    const { userId, attempt } = params;
    const user = await getUser({ userId });
    if (!user || user.tokenStatus !== SALESFORCE_TOKEN_STATUS.retryScheduled || user.tokenRetryAttempt !== Number(attempt)) {
        logger.info(`[salesforce token retry] user ${userId} attempt ${attempt} no longer due — skipping`);
        return;
    }

    try {
        await getFreshTokens(userId, { trigger: TOKEN_REFRESH_TRIGGER.retryWorker });
        logger.info(`[salesforce token retry] user ${userId} attempt ${attempt} succeeded`);
    } catch (error) {
        logger.warn(`[salesforce token retry] user ${userId} attempt ${attempt} failed: ${(error as Error)?.message ?? String(error)}`);
    }
};

export {
    runSalesforceTokenRetry
};
