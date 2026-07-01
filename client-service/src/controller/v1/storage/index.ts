import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getBackupConfigSizeRecordByCrmId } from "../../../services";


const overview = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user!;

    const crmId = req.headers['crm-id'] ? String(req.headers['crm-id']) : user.crmId;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const backupConfigSizeRecord = await getBackupConfigSizeRecordByCrmId(crmId);
    makeResponse(req, res, 200, true, 'fetch', backupConfigSizeRecord);
}