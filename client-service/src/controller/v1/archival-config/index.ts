import { SCHEDULE_MODE, BACKUP_CONFIG_TABLE } from "../../../constant";
import { IRequest, IResponse, makeResponse } from "../../../lib";
import { logger } from "../../../middlewares";
import {
  createBackupConfig,
  deleteBackupConfig,
  getApexFields,
  getApexObjectChilds,
  getDestinationById,
  triggerBackupJob,
  getBackupConfigsWithPagination,
  getCrmById,
  getTableCounter,
} from "../../../services";
import { wrapController } from "../../../utils/helper";


const getObjectChildHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const [apexResult] = await Promise.all([
        getApexObjectChilds(String(crmId), String(objectName)),
    ]);

    makeResponse(req, res, 200, true, 'fetch', { ...apexResult });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }
    if (!objectName) {
        return makeResponse(req, res, 400, false, 'object_name_required');
    }
    const result = await getApexFields(String(crmId), String(objectName));
    makeResponse(req, res, 200, true, 'fetch', result);
};

const listArchivalConfigsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { pagination, limit, cursor } = req.query as Record<string, string>;
    const spaceId = req.user?.spaceId;
    const userId = req.user!.userId;

    if (pagination === 'true') {
        const limitNum = Math.max(1, parseInt(limit ?? '10', 10));

        const result = await getBackupConfigsWithPagination(
            { ...(spaceId ? { spaceId } : { userId }), type: 'ARCHIVAL' },
            { limit: limitNum, cursor }
        );

        const { documents, nextCursor } = result;

        for (let index = 0; index < documents.length; index++) {
            const document = documents[index];

            const crm = await getCrmById(document.crmId);
            if (crm) {
                documents[index].crm = { name: crm.name, crmName: crm.crmName };
            }
        }

        const counter = spaceId ? null : await getTableCounter(BACKUP_CONFIG_TABLE, userId);

        return makeResponse(req, res, 200, true, 'fetch', documents, {
            limit: limitNum,
            nextCursor,
            totalRecords: counter?.count ?? 0,
            totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
        });
    }

    const { documents } = await getBackupConfigsWithPagination(
        { ...(spaceId ? { spaceId } : { userId }), type: 'ARCHIVAL' },
        { limit: 1000 }
    );

    makeResponse(req, res, 200, true, 'fetch', documents);
};

const createArchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const destination = await getDestinationById(String(req.body.destinationId));
    const isOwner = destination && (destination.userId === req.user!.userId || destination.spaceId === req.user?.spaceId);

    if (!isOwner) {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    const config = await createBackupConfig({
        userId: req.user!.userId,
        ...req.body,
        backupStatus: req.body.backupStatus || 'ACTIVE',
        ...(req.user?.spaceId && { spaceId: req.user.spaceId }),
        type: 'ARCHIVAL',
    });

    try {
        // Skip schedule/trigger setup if backupStatus is DRAFT
        if (config.backupStatus === 'DRAFT') {
            makeResponse(req, res, 201, true, 'create', config);
            return;
        }

        if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig) {
            const scheduleConfig = req.body.scheduleConfig;
            const isOnceImmediate = scheduleConfig?.scheduling?.frequency === 'ONCE'
                && !scheduleConfig?.scheduling?.startDate
                && !scheduleConfig?.scheduling?.startTime;
            if (isOnceImmediate) {
                await triggerBackupJob(config);
            } else {
                // await createAwsEventScheduler(buildEventScheduleInput(config));
            }
        }

        makeResponse(req, res, 201, true, 'create', config);
    } catch (error) {
        await deleteBackupConfig(config.backupConfigId);
        logger.error('Error creating backup config, Deleting backup config: ', error);
        throw error;
    }
};


export const archivalConfigController = wrapController({
    getObjectChildHanlder,
    getFieldsHanlder,
    listArchivalConfigsHandler,
    createArchivalConfigHandler
});