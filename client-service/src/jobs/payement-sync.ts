import { logger } from "../middlewares";
import { getCrmsInBatches, getUser, setupPayment, updateCrm } from "../services"
import { decrypt, EncryptedPayload } from "../utils/encryption";

const runPaymentSyncJob = async () => {
    try {
        getCrmsInBatches(async (crms) => {
            for (const crm of crms) {
                const user = await getUser({ userId: crm.userId });
                if (!user || !crm.paymentToken) continue;

                try {
                    const paymentToken = JSON.parse(decrypt(crm.paymentToken as EncryptedPayload)) as { sf_secret: string; token: string };
                    const setup = await setupPayment({
                        orgId: crm.organizationId,
                        token: paymentToken.token,
                        sfSecret: paymentToken.sf_secret,
                        orgInfo: {
                            OrgType: crm.environment === 'production' ? 'Production' : 'Sandbox',
                            orgName: '360SMS',
                            email: user.crmProfile?.email ?? '',
                            userName: user.crmProfile?.username ?? '',
                        },
                        isTokenEncrypted: true
                    });

                    const updatePaymentToken = {
                        sf_secret: paymentToken.sf_secret,
                        token: setup.token
                    }
                    const updatePaymentDetail = setup.data?.Success;
                    await updateCrm(crm.crmId, { paymentToken: updatePaymentToken, paymentDetail: updatePaymentDetail });
                } catch (error) {
                    logger.error(`[payment sync - CRON] crm ${crm.crmId} threw error: ${(error as Error)?.message ?? String(error)}`);
                }
            }
        })
    } catch (error) {
        logger.error(`[payment sync - CRON] tick threw error: ${(error as Error)?.message ?? String(error)}`);
    }
}

export {
    runPaymentSyncJob
}