import { logger } from "../../../../middlewares"
import { SalesforceTokens } from "../api-request";
import { childHandler } from "./child";
import { ISalesforceMetadataHandler } from "./common";
import { schemaHandler } from "./field";
import { picklistHandler } from "./picklist";
import { recordTypeHandler } from "./recordType";

// Only the "childs" comparison needs live Salesforce API access (see
// child/index.ts) — the rest resolve everything from backupConfigId via the
// core service. Optional so every other metadataType can omit it.
interface ISalesforceContext {
    instanceUrl: string;
    tokens: SalesforceTokens;
}

export const salesforceMetadataHandler = async (
    params: ISalesforceMetadataHandler,
    salesforceContext?: ISalesforceContext
) => {
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
                if (!salesforceContext) {
                    throw new Error(`childs comparison requires instanceUrl + tokens`);
                }
                const diff = await childHandler(params, salesforceContext.instanceUrl, salesforceContext.tokens);
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
