import { logger } from "../../../../middlewares"
import { ISalesforceMetadataHandler } from "./common";
import { schemaHandler } from "./field";
import { picklistHandler } from "./picklist";

const childHandler = async () => {
    try {
    } catch (error) {
        throw error;
    }
}

const recordTypeComparison = async () => {

}

const recordTypeHandler = async () => {
    try {
        await recordTypeComparison();
    } catch (error) {
        throw error;
    }
}

const salesforceMetadataHandler = async (params: ISalesforceMetadataHandler) => {
    const { metadataType } = params;
    try {
        switch (metadataType) {
            case "fields":
                await schemaHandler(params);
                break;
            case "childs":
                await childHandler();
                break;
            case "picklist":
                await picklistHandler(params);
                break;
            case "recordTypes":
                await recordTypeHandler();
                break;
        }
    } catch (error) {
        logger.error(`[salesforce:metadata] handleSalesforceMetadata failed | err: ${error}`);
    }
}
