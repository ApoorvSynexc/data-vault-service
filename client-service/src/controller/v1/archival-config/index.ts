import { SCHEDULE_MODE } from "../../../constant";
import { IRequest, IResponse, makeResponse } from "../../../lib";
import { logger } from "../../../middlewares";
import { createBackupConfig, deleteBackupConfig, getApexFields, getApexObjectChilds, getDestinationById, triggerBackupJob } from "../../../services";
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
    createArchivalConfigHandler
});