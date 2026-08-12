import { logger } from "../../../../middlewares";
import { IUser } from "../../../../models";
import { childHandler } from "./child";
import { ISalesforceMetadataHandler } from "./common";
import { schemaHandler } from "./field";
import { picklistHandler } from "./picklist";
import { recordTypeHandler } from "./recordType";

// Unlike backup-service's orchestrator, no salesforceContext (instanceUrl/tokens)
// needs to be threaded in here — every apex.ts call this module makes (including
// childHandler's) resolves Salesforce credentials itself from the user record.
//
// `knownUser` is optional — a caller that already has the user in hand (e.g. a
// job comparing many objects/metadataTypes for the same config) can pass it
// through to skip a redundant getUser() per call; omit it and each handler
// resolves the user itself from params.backupConfigId.
export const salesforceMetadataHandler = async (
    params: ISalesforceMetadataHandler,
    knownUser?: IUser
) => {
    const { metadataType, backupConfigId, backupJobId, objectName } = params;
    try {
        logger.info(
            `Object metadata comparison started, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}`
        );

        switch (metadataType) {
            case "fields": {
                const diff = await schemaHandler(params, knownUser);
                return { diff, metadataType };
            }
            case "childs": {
                const diff = await childHandler(params, knownUser);
                return { diff, metadataType };
            }
            case "picklist": {
                const diff = await picklistHandler(params, knownUser);
                return { diff, metadataType };
            }
            case "recordTypes": {
                const diff = await recordTypeHandler(params, knownUser);
                return { diff, metadataType };
            }
        }
    } catch (error: any) {
        logger.error(
            `Object metadata comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}, errorMsg=${error?.message ?? error}`
        );
    }
}
