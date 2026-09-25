import { logger } from "../../../../middlewares";
import { flattenBackupObjects } from "../../../../utils/helper";
import { getBackupConfigById } from "../../../backup-config";
import { getRestoreById } from "../../../restore";
import { getRestoreJobById } from "../../../restore-job";
import { getDecryptedCrmCredential, getUser } from "../../../user";
import { ensureRestoreTrackingFields, IRestoreTrackingField } from "../restore-fields";
import { provisionRestorePermissionSet } from "../restore-permission-set";

// object API name -> the tracking fields ensureRestoreTrackingFields found
// missing (and created) for it this run. Handed to salesforceFieldsPermission
// so the permission set only ever grants access to a field this restore
// actually created — a fresh describe at permission-grant time can't answer
// that, since by then creation has already happened and every tracking field
// looks pre-existing.
export type NewFieldsByObject = Map<string, IRestoreTrackingField[]>;

export const salesforceFieldCreation = async (params: { restoreJobId: string }): Promise<NewFieldsByObject> => {
    const { restoreJobId } = params;
    const newFieldsByObject: NewFieldsByObject = new Map();

    logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} start`);
    try {

        const restoreJob = await getRestoreJobById(restoreJobId);
        if (!restoreJob) {
            return newFieldsByObject;
        }

        const restore = await getRestoreById(restoreJob.restoreId);
        if (!restore) {
            return newFieldsByObject;
        }

        const backupConfig = await getBackupConfigById(restoreJob.source.backupConfigId);
        if (!backupConfig || !backupConfig.objects) {
            return newFieldsByObject;
        }

        const user = await getUser({ userId: restore.userId });
        if (!user) {
            return newFieldsByObject;
        }

        // const objects = restoreJob.destination.objects;
        const objects = flattenBackupObjects(backupConfig.objects);
        if (user?.crmProfile?.instanceUrl) {
            const tokens = getDecryptedCrmCredential(user);
            const credentials = {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
            }
            for (let index = 0; index < objects.length; index++) {
                const object = objects[index];
                try {
                    const created = await ensureRestoreTrackingFields(
                        user?.crmProfile?.instanceUrl,
                        credentials,
                        object.name
                    );
                    newFieldsByObject.set(object.name, created);
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
    return newFieldsByObject;
}
export const salesforceFieldsPermission = async (params: { restoreJobId: string; newFieldsByObject?: NewFieldsByObject }) => {
    const { restoreJobId, newFieldsByObject = new Map() } = params;

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

        const backupConfig = await getBackupConfigById(restoreJob.source.backupConfigId);
        if (!backupConfig || !backupConfig.objects) {
            return;
        }

        const user = await getUser({ userId: restore.userId });
        if (!user) {
            return;
        }

        // const objects = restoreJob.destination.objects;
        const objects = flattenBackupObjects(backupConfig.objects);
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
                objectsNames,
                newFieldsByObject
            );
            logger.info(`[salesforce-fields-permission] restoreJobId=${restoreJobId} object=${objectsNames.length} done`);
        }

        logger.info(`[salesforce-fields-permission] restoreJobId=${restoreJobId} done`);
    } catch (error) {
        logger.error(`[salesforce-fields-permission] restoreJobId=${restoreJobId} err:${error}`);
    }
}

