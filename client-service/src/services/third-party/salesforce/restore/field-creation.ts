import { logger } from "../../../../middlewares";
import { STATUS, RESTORE_TRACKING_FIELDS, IRestoreTrackingField } from "../../../../constant";
import { flattenBackupObjects } from "../../../../utils/helper";
import { getBackupConfigById } from "../../../backup-config";
import { getRestoreById } from "../../../restore";
import { getRestoreJobById, updateRestoreJob } from "../../../restore-job";
import { initalizeRestoreTransform } from "../../../payload";
import { getDecryptedCrmCredential, getUser } from "../../../user";
import { ensureRestoreTrackingFields } from "../restore-fields";
import { provisionRestorePermissionSet } from "../restore-permission-set";

// object API name -> the tracking fields to grant field-level permission for.
// Set to the FULL RESTORE_TRACKING_FIELDS list for every object that resolved
// without throwing — ensureRestoreTrackingFields never resolves unless all 3
// fields genuinely exist on the object afterward (pre-existing or just
// created), so "resolved" already means "grant permission for all 3," not
// just whichever subset happened to be newly created this particular run.
// An object salesforceFieldCreation never reached (or failed for) simply has
// no entry, so it gets object permissions only, never a field-permission
// grant for a field that might not exist.
export type NewFieldsByObject = Map<string, IRestoreTrackingField[]>;

export const salesforceFieldCreation = async (params: { restoreJobId: string }): Promise<NewFieldsByObject> => {
    const { restoreJobId } = params;
    const newFieldsByObject: NewFieldsByObject = new Map();
    // Every object is still attempted even after one fails (per-object try/catch
    // below), but the run as a whole is no longer allowed to succeed silently —
    // a restore whose ingest depends on a tracking field that failed to create
    // must not proceed as if nothing went wrong. See runRestoreFieldSetupAndTransform.
    const failedObjects: string[] = [];

    logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} start`);

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
                await ensureRestoreTrackingFields(
                    user?.crmProfile?.instanceUrl,
                    credentials,
                    object.name
                );
                newFieldsByObject.set(object.name, RESTORE_TRACKING_FIELDS);
                logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} object=${object.name} done`);
            } catch (error) {
                logger.error(`[salesforce-field-creation] restoreJobId=${restoreJobId} object=${object.name} err:${error}`);
                failedObjects.push(object.name);
            }
        }
    }

    logger.info(`[salesforce-field-creation] restoreJobId=${restoreJobId} done`);
    if (failedObjects.length) {
        throw new Error(`field_creation_failed:${failedObjects.join(',')}`);
    }
    return newFieldsByObject;
}
export const salesforceFieldsPermission = async (params: { restoreJobId: string; newFieldsByObject?: NewFieldsByObject }): Promise<void> => {
    const { restoreJobId, newFieldsByObject = new Map() } = params;

    logger.info(`[salesforce-fields-permission] restoreJobId=${restoreJobId} start`);

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
        // Not wrapped in try/catch: a permission-set deploy failure here means
        // the destination org may not actually be able to write the objects/
        // fields this restore needs, so it must propagate — see
        // runRestoreFieldSetupAndTransform, the only caller.
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
}

// The single entry point CREATE_RESTORE's flow uses to run field setup and
// then kick off the actual restore transform (EMR/Spark, then Bulk API
// ingest). Ingest depends on the tracking fields/permissions this sets up
// (DC_External_Id__c doubles as the ingest-stage upsert key — see
// restore-fields.ts) existing on every restored object, so a failure in
// either step must fail the restore job outright rather than let ingest run
// against an org that's missing what it needs.
export const runRestoreFieldSetupAndTransform = async (restoreJobId: string): Promise<void> => {
    try {
        const newFieldsByObject = await salesforceFieldCreation({ restoreJobId });
        await salesforceFieldsPermission({ restoreJobId, newFieldsByObject });
    } catch (error) {
        const errorMessage = (error as Error)?.message ?? String(error);
        logger.error(`[restore-field-setup] restoreJobId=${restoreJobId} failed, failing restore job: ${errorMessage}`);
        await updateRestoreJob({ restoreJobId, status: STATUS.failed, errorMessage });
        return;
    }
    await initalizeRestoreTransform(restoreJobId);
}

