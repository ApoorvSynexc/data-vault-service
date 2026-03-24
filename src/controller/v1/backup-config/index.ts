import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getApexFields, getApexObjects, createBackupConfig, getBackupConfigById, getBackupConfigsByUser, updateBackupConfig, deleteBackupConfig } from '../../../services';
import { wrapController } from '../../../utils/helper';
import { IBackupConfig } from '../../../models';

const sanitize = ({ destination, ...rest }: IBackupConfig) => ({
    ...rest,
    destination: { type: destination.type },
});

const getObjectsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId } = req.query;
    if (!crmId) return makeResponse(req, res, 400, false, 'crm_id_required');
    const result = await getApexObjects(String(crmId));
    makeResponse(req, res, 200, true, 'fetch', result);
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName } = req.query;
    if (!crmId) return makeResponse(req, res, 400, false, 'crm_id_required');
    if (!objectName) return makeResponse(req, res, 400, false, 'object_name_required');
    const result = await getApexFields(String(crmId), String(objectName));
    makeResponse(req, res, 200, true, 'fetch', result);
};

const createBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const config = await createBackupConfig({ userId: req.user!.userId, ...req.body });
    makeResponse(req, res, 201, true, 'create', sanitize(config));
};

const listBackupConfigsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const configs = await getBackupConfigsByUser(req.user!.userId);
    makeResponse(req, res, 200, true, 'fetch', configs.map(sanitize));
};

const getBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupConfigId } = req.query;
    if (!backupConfigId) return makeResponse(req, res, 400, false, 'id_required');

    const config = await getBackupConfigById(String(backupConfigId));
    if (!config || config.userId !== req.user!.userId) {
        makeResponse(req, res, 404, false, 'not_found');
        return;
    }
    makeResponse(req, res, 200, true, 'fetch', sanitize(config));
};

const updateBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupConfigId } = req.query;
    if (!backupConfigId) return makeResponse(req, res, 400, false, 'id_required');

    const existing = await getBackupConfigById(String(backupConfigId));
    if (!existing || existing.userId !== req.user!.userId) {
        makeResponse(req, res, 404, false, 'not_found');
        return;
    }

    const updated = await updateBackupConfig(String(backupConfigId), req.body);
    makeResponse(req, res, 200, true, 'update', sanitize(updated!));
};

const deleteBackupConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupConfigId } = req.query;
    if (!backupConfigId) return makeResponse(req, res, 400, false, 'id_required');

    const existing = await getBackupConfigById(String(backupConfigId));
    if (!existing || existing.userId !== req.user!.userId) {
        makeResponse(req, res, 404, false, 'not_found');
        return;
    }

    await deleteBackupConfig(String(backupConfigId));
    makeResponse(req, res, 200, true, 'delete');
};

export const backupConfigController = wrapController({
    getObjectsHanlder,
    getFieldsHanlder,
    createBackupConfigHandler,
    listBackupConfigsHandler,
    getBackupConfigHandler,
    updateBackupConfigHandler,
    deleteBackupConfigHandler,
});
