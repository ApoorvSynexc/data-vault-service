import { SCHEDULE_MODE, BACKUP_CONFIG_TABLE, BACKUP_STATUS } from "../../../constant";
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
    getBackupConfigBySlug,
    getBackupConfigById,
    updateBackupConfig,
    getCrmTokens,
    getSalesforceProfile,
    deleteBackupJobsByConfig,
    realTimeTriggerManagement,
    computeJobStats,
    computeArchivalJobStats,
} from "../../../services";
import { isOwner, wrapController } from "../../../utils/helper";
import { dryRun, validateSoql } from "../../../services/third-party/salesforce/dry-run";


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
                await triggerBackupJob(config, undefined, 'archival');
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

const dryRunArchivalHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    try {
        const result = await dryRun(req.body);
        makeResponse(req, res, 201, true, 'create', result);
    } catch (error) {
        logger.error('Error creating backup config, Deleting backup config: ', error);
        throw error;
    }
};

const validateSoqlArchivalHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const result = await validateSoql(req.body);
    makeResponse(req, res, 200, true, 'fetch', result);
};


const getArchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { slug } = req.query;
    if (!slug) {
        return makeResponse(req, res, 400, false, 'slug_required');
    }

    const config = await getBackupConfigBySlug({
        userId: req.user!.userId,
        slug: String(slug),
        spaceId: req.user?.spaceId,
    });
    if (!config) {
        makeResponse(req, res, 400, false, 'backup_config_not_found');
        return;
    }

    const crmPayload = await getCrmById(config.crmId);
    if (!crmPayload) {
        makeResponse(req, res, 400, false, 'crm_not_found');
        return;
    }

    const destination = await getDestinationById(config.destinationId);
    if (!destination) {
        makeResponse(req, res, 400, false, 'destination_not_found');
        return;
    }

    const crmDetail = {
        crmId: crmPayload.crmId,
        crmName: crmPayload.crmName,
        name: crmPayload.name,
        slug: crmPayload.slug,
        environment: crmPayload.environment,
        isConnected: crmPayload.isConnected,
    };
    const destinationDetail = {
        destinationId: destination.destinationId,
        destinationName: destination.name,
        type: destination.type,
    };
    makeResponse(req, res, 200, true, 'fetch', { ...config, crmDetail, destinationDetail });
};

const updateArchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupConfigId } = req.query;
    if (!backupConfigId) {
        return makeResponse(req, res, 400, false, 'id_required');
    }

    const existing = await getBackupConfigById(String(backupConfigId));
    if (existing && (!isOwner(existing, req.user!.userId) || existing.type !== 'ARCHIVAL')) {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    const updated = await updateBackupConfig(String(backupConfigId), req.body);

    if (updated!.schedule === SCHEDULE_MODE.schedule && req.body!.scheduleConfig) {
        // await updateAwsEventSchedule(buildEventScheduleInput(updated!));
    }

    makeResponse(req, res, 200, true, 'update', updated!);
};

const deletearchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupConfigId } = req.query;
    if (!backupConfigId) {
        return makeResponse(req, res, 400, false, 'id_required');
    }

    const existing = await getBackupConfigById(String(backupConfigId));
    const spaceId = req.user?.spaceId;
    const userId = req.user!.userId;

    const isConfigOwner = spaceId ? existing?.spaceId === spaceId : existing?.userId === userId;
    if (!isConfigOwner || existing?.type !== 'ARCHIVAL') {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }
    const config = existing!;

    if (config.backupStatus === BACKUP_STATUS.pending) {
        makeResponse(req, res, 400, false, 'backup_pending_cannot_delete');
        return;
    }

    try {
        if (config.schedule === SCHEDULE_MODE.realtime) {
            const crm = await getCrmById(config.crmId);
            if (crm) {
                const tokens = getCrmTokens(crm) as any;
                await getSalesforceProfile(
                    {
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                        userId: crm.userId,
                    },
                    crm.environment
                );
            }
            // const triggerResults = await realTimeTriggerManagement('delete', config);
            // console.log({ triggerResults });
        } else if (config.schedule === SCHEDULE_MODE.schedule && config.scheduleConfig?.type === 'INCREMENTAL') {
            // await deleteAwsEventScheduler(`datavault-${config.backupConfigId}`);
        }

        await Promise.all([
            deleteBackupConfig(String(backupConfigId)),
            deleteBackupJobsByConfig(String(backupConfigId), config.userId),
        ]);

        makeResponse(req, res, 200, true, 'delete');
        if (config.schedule === SCHEDULE_MODE.realtime) {
            const triggerResults = await realTimeTriggerManagement('delete', config);
            console.log({ triggerResults });
        }
    } catch (error) {
        throw error;
    }
};

const getArchivalJobStatsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { slug } = req.query;
    const spaceId = req.user!.spaceId;
    const userId = req.user!.userId;

    if (slug) {
        const config = await getBackupConfigBySlug({
            userId: req.user!.userId,
            slug: String(slug),
            spaceId: req.user?.spaceId,
            type: 'NORMAL'
        });
        if (!config) {
            makeResponse(req, res, 400, false, 'backup_config_not_found');
            return;
        }
        const stats = await computeArchivalJobStats({ indexName: 'backupConfigId-index', keyName: 'backupConfigId', keyValue: config.backupConfigId });
        makeResponse(req, res, 200, true, 'fetch', stats);
        return;
    }

    let indexName = 'userId-index';
    let keyName = 'userId';
    let keyValue = userId;

    if (spaceId) {
        indexName = 'spaceId-index';
        keyName = 'spaceId';
        keyValue = spaceId;
    }

    const stats = await computeArchivalJobStats({ indexName, keyName, keyValue });
    makeResponse(req, res, 200, true, 'fetch', stats);
};

export const archivalConfigController = wrapController({
    getObjectChildHanlder,
    getFieldsHanlder,
    listArchivalConfigsHandler,
    createArchivalConfigHandler,
    getArchivalConfigHandler,
    updateArchivalConfigHandler,
    deletearchivalConfigHandler,
    getArchivalJobStatsHandler,
    dryRunArchivalHandler,
    validateSoqlArchivalHandler,
});