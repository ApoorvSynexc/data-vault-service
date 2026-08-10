import { logger } from "../../../../middlewares"

interface ISalesforceMetadataHandler {
    metadataType: "fields" | "childs" | "metadataType" | "recordTypes";
    policyConfigType: "backup" | "archival";
    crmName: string;
    crmId: string;
    backupConfigId: string;
    objectName: string;
    backupJobId: string;
}

const schemaComparison = async () => {

}

const metadataTypeComparison = async () => {

}

const recordTypeComparison = async () => {

}



const schemaHandler = async () => {
    try {
        await schemaComparison();
    } catch (error) {
        throw error;
    }
}
const childHandler = async () => {
    try {
    } catch (error) {
        throw error;
    }
}
const metadataTypeHandler = async () => {
    try {

        await metadataTypeComparison();
    } catch (error) {
        throw error;
    }
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
                await schemaHandler();
                break;
            case "childs":
                await childHandler();
                break;
            case "metadataType":
                await metadataTypeHandler();
                break;
            case "recordTypes":
                await recordTypeHandler();
                break;
        }
    } catch (error) {
        logger.error(`[salesforce:metadata] handleSalesforceMetadata failed | err: ${error}`);
    }
}