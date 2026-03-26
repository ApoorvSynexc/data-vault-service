import { IRequest, IResponse, makeResponse } from '../../../lib';
import { getApexFields, getApexObjects, createBackupConfig, getBackupConfigById, getBackupConfigsByUser, getBackupConfigsByUserWithPagination, updateBackupConfig, deleteBackupConfig, getTableCounter, getCrmById, getCrmTokens } from '../../../services';
import { BACKUP_CONFIG_TABLE, BACKUP_SERVICE } from '../../../constant';
import { wrapController } from '../../../utils/helper';
import { IBackupConfig } from '../../../models';
import { httpRequest } from '../../../utils/http-request';

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
    const { pagination, limit, cursor } = req.query as Record<string, string>;
    const userId = req.user!.userId;

    if (pagination === 'true') {
        const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

        const [{ documents, nextCursor }, counter] = await Promise.all([
            getBackupConfigsByUserWithPagination(userId, { limit: limitNum, cursor }),
            getTableCounter(BACKUP_CONFIG_TABLE, userId),
        ]);

        return makeResponse(req, res, 200, true, 'fetch', documents.map(sanitize), {
            limit: limitNum,
            nextCursor,
            totalRecords: counter?.count ?? 0,
            totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
        });
    }

    const configs = await getBackupConfigsByUser(userId);
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

const testBackupHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const crm = await getCrmById(req.body.crmId);
    if (!crm) {
        makeResponse(req, res, 404, false, 'not_found');
        return;
    }
    const credentials = await getCrmTokens(crm);
    const source = { 
        ...credentials, 
        crmId: crm.crmId, 
        crmName: crm.crmName, 
        instanceUrl: crm.crmProfile?.instanceUrl,
        objects:[
            {
                name: "Account",
                field: []
            },
            {
                name: "Contact",
                field: []
            }
        ]
    };
    const destination = req.body.destination;
    const payload = {
        userId: req.user!.userId,
        backupConfigId: req.body.backupConfigId,
        source,
        destination
    };
    const result = await httpRequest({ url: `${BACKUP_SERVICE}/v1/backup-job`, method: 'POST', body: JSON.stringify(payload) });
    makeResponse(req, res, 200, true, 'fetch', result);
}

export const backupConfigController = wrapController({
    getObjectsHanlder,
    getFieldsHanlder,
    createBackupConfigHandler,
    listBackupConfigsHandler,
    getBackupConfigHandler,
    updateBackupConfigHandler,
    deleteBackupConfigHandler,
    testBackupHandler
});
