import { logger } from "../../../../middlewares";
import { childHandler } from "./child";
import { ISalesforceMetadataHandler } from "./common";
import { schemaHandler } from "./field";
import { picklistHandler } from "./picklist";
import { recordTypeHandler } from "./recordType";

// Unlike backup-service's orchestrator, no salesforceContext (instanceUrl/tokens)
// needs to be threaded in here — every apex.ts call this module makes (including
// childHandler's) resolves Salesforce credentials itself from the user record.
export const salesforceMetadataHandler = async (params: ISalesforceMetadataHandler) => {
    const { metadataType, backupConfigId, backupJobId, objectName } = params;
    try {
        logger.info(
            `Object metadata comparison started, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}`
        );

        switch (metadataType) {
            case "fields": {
                const diff = await schemaHandler(params);
                return { diff, metadataType };
            }
            case "childs": {
                const diff = await childHandler(params);
                return { diff, metadataType };
            }
            case "picklist": {
                const diff = await picklistHandler(params);
                return { diff, metadataType };
            }
            case "recordTypes": {
                const diff = await recordTypeHandler(params);
                return { diff, metadataType };
            }
        }
    } catch (error: any) {
        logger.error(
            `Object metadata comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, metadataType=${metadataType}, errorMsg=${error?.message ?? error}`
        );
    }
}
