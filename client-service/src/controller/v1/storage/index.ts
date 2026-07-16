import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getBackupConfigSizeRecordByCrmId, getLastBackupJobByCrm, getLastNBackupConfigByCrm, getMonthlyStatsByCrmCurrentYear } from "../../../services";
import { wrapController } from "../../../utils/helper";


const overview = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user!;

    const crmId = req.headers['crm-id'] ? String(req.headers['crm-id']) : user.crmId;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const [backupConfigSizeRecord, lastBackupJob, monthlyStats] = await Promise.all([
        getBackupConfigSizeRecordByCrmId(crmId),
        getLastBackupJobByCrm(crmId, "NORMAL"),
        getMonthlyStatsByCrmCurrentYear(crmId)
    ]);

    const payload = {
        backupConfigSizeRecord,
         lastBackupJob,
          monthlyStats
    }

    makeResponse(req, res, 200, true, 'fetch', payload);
}

const lastNBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user!;
    const { type } = req.query as { type: "NORMAL" | "ARCHIVAL" };

    const crmId = req.headers['crm-id'] ? String(req.headers['crm-id']) : user.crmId;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const backupConfigSizeRecord = await getLastNBackupConfigByCrm(crmId, 5, type ?? "NORMAL");
    makeResponse(req, res, 200, true, 'fetch', backupConfigSizeRecord);
}

export const storageController = wrapController({
    overview,
    lastNBackupConfigHandler,
})