import { logger } from "../../../../middlewares";
import { getRestoreById } from "../../../restore";
import { getRestoreJobById } from "../../../restore-job";
import { getDecryptedCrmCredential, getUser } from "../../../user";
import { ensureRestoreTrackingFields } from "../restore-fields";
import { provisionRestorePermissionSet } from "../restore-permission-set";

export const salesforceFieldCreation = async (params: { restoreJobId: string }) => {
    const { restoreJobId } = params;

    logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} start`);
    try {

        const restoreJob = await getRestoreJobById(restoreJobId);
        if (!restoreJob) {
            return;
        }

        const restore = await getRestoreById(restoreJob.restoreId);
        if (!restore) {
            return;
        }

        const user = await getUser({ userId: restore.userId });
        if (!user) {
            return;
        }

        const objects = restoreJob.destination.objects;
        if (user?.crmProfile?.instanceUrl) {
            const tokens = getDecryptedCrmCredential(user);
            const credentials = {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
            }
            for (let index = 0; index < objects.length; index++) {
                const object = objects[index];
                try {
                    await ensureRestoreTrackingFields(
                        user?.crmProfile?.instanceUrl,
                        credentials,
                        object.name
                    );
                    logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} object=${object.name} done`);
                } catch (error) {
                    logger.error(`[salesforce-field-creation] restoreJobId=${restoreJobId} object=${object.name} err:${error}`);
                }
            }
        }

        logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} done`);
    } catch (error) {
        logger.error(`[salesforce-field-creation] restoreJobId=${restoreJobId} err:${error}`);
    }
}

export const salesforceFieldsPermission = async (params: { restoreJobId: string }) => {
    const { restoreJobId } = params;

    logger.info(`[salesforce-fields-permission] restoreJobId=${restoreJobId} start`);
    try {

        const restoreJob = await getRestoreJobById(restoreJobId);
        if (!restoreJob) {
            return;
        }

        const restore = await getRestoreById(restoreJob.restoreId);
        if (!restore) {
            return;
        }

        const user = await getUser({ userId: restore.userId });
        if (!user) {
            return;
        }

        const objects = restoreJob.destination.objects;
        if (user?.crmProfile?.instanceUrl) {
            const tokens = getDecryptedCrmCredential(user);
            const credentials = {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
            }

            const objectsNames = objects.map((object) => object.name);
            await provisionRestorePermissionSet(
                user?.crmProfile?.instanceUrl,
                credentials,
                user.crmProfile.userId,
                objectsNames
            );
            logger.info(`[salesforce-fields-permission] restoreJobId=${restoreJobId} object=${objectsNames.length} done`);
        }

        logger.info(`[salesforce-fields-permission] restoreJobId=${restoreJobId} done`);
    } catch (error) {
        logger.error(`[salesforce-fields-permission] restoreJobId=${restoreJobId} err:${error}`);
    }
}