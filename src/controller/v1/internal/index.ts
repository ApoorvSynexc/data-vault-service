import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getCrmById, getCrmTokens, getApexFields, updateCrmCredentials, updateBackupConfig } from "../../../services";
import { BACKUP_STATUS } from "../../../constant";
import { refreashSalesforceToken, SalesforceAuthExpiredError } from "../../../services/third-party/salesforce";
import { wrapController } from "../../../utils/helper";

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName } = req.query;
    if (!crmId) return makeResponse(req, res, 400, false, 'crm_id_required');
    if (!objectName) return makeResponse(req, res, 400, false, 'object_name_required');
    const result = await getApexFields(String(crmId), String(objectName));
    makeResponse(req, res, 200, true, 'fetch', result);
};

const crmRefreshTokenHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId } = req.query;

    if (!crmId) {
        makeResponse(req, res, 400, false, 'crm_id_required');
        return;
    }

    const crm = await getCrmById(String(crmId));
    if (!crm) {
        makeResponse(req, res, 404, false, 'not_found');
        return;
    }

    const tokens = getCrmTokens(crm);

    let refreshed: any;
    try {
        refreshed = await refreashSalesforceToken(tokens.refresh_token);
    } catch {
        throw new SalesforceAuthExpiredError();
    }

    const newAccessToken: string = refreshed.access_token;
    const newRefreshToken: string = refreshed.refresh_token ?? tokens.refresh_token;

    await updateCrmCredentials(String(crmId), { access_token: newAccessToken, refresh_token: newRefreshToken });

    makeResponse(req, res, 200, true, 'update', refreshed);
};

const getBackupServicePayloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { eventType, backupConfigId } = req.body;
    console.log(`Received an hit from backup service for event ${eventType}`);
    makeResponse(req, res, 200, true, 'update');

    try {
        switch (eventType) {
            case "backup.completed":
                await updateBackupConfig(backupConfigId, {
                    backupStatus: BACKUP_STATUS.success,
                    lastBackupAt: new Date().toISOString(),
                });
                break;
            case "backup.size.updated":
                await updateBackupConfig(backupConfigId, { sizeInBytes: req.body.sizeInBytes });
                break;
            case "schema.updated":
                await updateBackupConfig(backupConfigId, { schemaChange: true });
                break;
            default:
                break;
        }
    } catch (error) {
        console.log(`Error in event ${eventType} `, error);
    }
};

export const internalController = wrapController({
    getFieldsHanlder,
    crmRefreshTokenHandler,
    getBackupServicePayloadHandler
});
