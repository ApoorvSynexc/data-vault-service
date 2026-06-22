import { SCHEDULE_MODE, BACKUP_CONFIG_TABLE, BACKUP_STATUS, STATUS, SCHEDULE_TYPE } from "../../../constant";
import { IRequest, IResponse, makeResponse } from "../../../lib";
import { logger } from "../../../middlewares";
import {
    createBackupConfig,
    deleteBackupConfig,
    getApexFields,
    getApexObjectChilds,
    getDestinationById,
    getBackupConfigsWithPagination,
    getCrmById,
    getTableCounter,
    getBackupConfigBySlug,
    getBackupConfigById,
    updateBackupConfig,
    getSalesforceProfile,
    deleteBackupJobsByConfig,
    realTimeTriggerManagement,
    computeJobStats,
    computeArchivalJobStats,
    getApexObjectRecords,
    triggerArchivalBackupJob,
    getBackupJobById,
    getDecryptedDestinationConfig,
} from "../../../services";
import { filtereObjects, isOwner, wrapController } from "../../../utils/helper";
import { dryRun, validateSoql } from "../../../services/third-party/salesforce/dry-run";
import { IObject } from "../../../models";
import { buildOwnWhereBody } from "../../../services/third-party/salesforce/dry-run/soql-builder";
import { listS3Keys, getS3Text } from "../../../utils/validate-aws-credentials";
import { decrypt } from "../../../utils/encryption";


const getObjectChildHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { crmId, objectName, mode } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const [apexResult] = await Promise.all([
        getApexObjectChilds({ user, objectName: String(objectName), mode: mode ? String(mode) : undefined }),
    ]);

    makeResponse(req, res, 200, true, 'fetch', { ...apexResult });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { crmId, objectName, mode } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }
    if (!objectName) {
        return makeResponse(req, res, 400, false, 'object_name_required');
    }
    const result = await getApexFields({ user, objectName: String(objectName), mode: mode ? String(mode) : undefined });
    makeResponse(req, res, 200, true, 'fetch', result);
};

const getObjectRecordsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { crmId, objectConfig, ...body } = req.body;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    // Build WHERE clause from objectConfig if the caller didn't supply one directly
    if (objectConfig && !body.whereClause) {
        const whereBody = buildOwnWhereBody(objectConfig);
        if (whereBody) {
            body.whereClause = whereBody;
        }
    }

    const apexResult = await getApexObjectRecords({ user, body });
    makeResponse(req, res, 200, true, 'fetch', apexResult);
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
    const user = req.user;
    const destination = await getDestinationById(String(req.body.destinationId));
    const isOwner = destination && (destination.userId === req.user!.userId || destination.spaceId === req.user?.spaceId);

    if (!isOwner) {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    const config = await createBackupConfig({
        userId: req.user!.userId,
        ...req.body,
        status: req.body.status || 'ACTIVE',
        ...(req.user?.spaceId && { spaceId: req.user.spaceId }),
        type: 'ARCHIVAL',
    });

    try {
        // Skip schedule/trigger setup if status is DRAFT
        if (config.status === 'DRAFT') {
            makeResponse(req, res, 201, true, 'create', config);
            return;
        }

        const { immediateObjects } = filtereObjects(req.body?.objects || []);
        if (immediateObjects.length > 0) {
            await triggerArchivalBackupJob({ user, config, objects: immediateObjects });
        } else {
            // await createAwsEventScheduler(buildEventScheduleInput(config));
        }

        makeResponse(req, res, 201, true, 'create', config);
    } catch (error) {
        await deleteBackupConfig(config.backupConfigId);
        logger.error('Error creating backup config, Deleting backup config: ', error);
        throw error;
    }
};

const dryRunArchivalHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    try {
        const result = await dryRun({...req.body, user});
        makeResponse(req, res, 201, true, 'create', result);
    } catch (error) {
        logger.error('Error creating backup config, Deleting backup config: ', error);
        throw error;
    }
};

const validateSoqlArchivalHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const result = await validateSoql({...req.body, user});    makeResponse(req, res, 200, true, 'fetch', result);
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
    };
    const destinationDetail = {
        destinationId: destination.destinationId,
        destinationName: destination.name,
        type: destination.type,
    };
    makeResponse(req, res, 200, true, 'fetch', { ...config, crmDetail, destinationDetail });
};

const updateArchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
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
    if (updated && !updated.lastBackupAt) {
        const { immediateObjects } = filtereObjects(req.body?.objects || []);
        if (immediateObjects.length > 0) {
            await triggerArchivalBackupJob({ user, config: updated, objects: immediateObjects });
        }
    }

    if (updated!.schedule === SCHEDULE_MODE.schedule && req.body!.scheduleConfig) {
        // await updateAwsEventSchedule(buildEventScheduleInput(updated!));
    }

    makeResponse(req, res, 200, true, 'update', updated!);
};

const deletearchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { backupConfigId } = req.query;
    if (!backupConfigId) {
        return makeResponse(req, res, 400, false, 'id_required');
    }

    if(!user) {
        return makeResponse(req, res, 400, false, 'not_exist');
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

    if (config.backupStatus === BACKUP_STATUS.pending && config.status !== STATUS.paused) {
        makeResponse(req, res, 400, false, 'backup_pending_cannot_delete');
        return;
    }

    try {
        if (config.schedule === SCHEDULE_MODE.realtime) {
            const crm = await getCrmById(config.crmId);
            if (crm) {
                const credentials = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : undefined;
                await getSalesforceProfile(
                    {
                        accessToken: credentials.access_token,
                        refreshToken: credentials.refresh_token,
                        userId: user.userId,
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

const PAGE_SIZE = 10;
const BATCH_SIZE = 200; // records per S3 file

// GET /v1/archival-config/record-errors?backupJobId=&objectId=&page=
// Returns one page (10 records) of per-record delete errors stored in S3.
// S3 files are named batch_00001.csv, batch_00002.csv … each holding 200 records.
// Page → file mapping is deterministic so forward/backward navigation never
// skips or repeats records: file_idx = floor((page-1)*10 / 200).
const getRecordErrorsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupJobId, objectId, page } = req.query as Record<string, string>;
    if (!backupJobId || !objectId) {
        makeResponse(req, res, 400, false, 'params_required');
        return;
    }

    const pageNum = Math.max(1, parseInt(page ?? '1', 10));

    const job = await getBackupJobById(backupJobId);
    if (!job || (job.userId !== req.user!.userId && job.spaceId !== req.user?.spaceId)) {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    // Find the target object (flat search — objects can be nested in children[])
    const findObject = (items: any[]): any => {
        for (const obj of items) {
            if (obj.id === objectId) return obj;
            if (obj.children?.length) {
                const found = findObject(obj.children);
                if (found) return found;
            }
        }
        return null;
    };

    const targetObj = findObject(job.object ?? []);
    if (!targetObj?.recordErrorsS3Prefix) {
        makeResponse(req, res, 200, true, 'fetch', { records: [], totalRecords: 0, totalPages: 0, page: pageNum });
        return;
    }

    // Resolve destination config via the backup config's destinationId.
    // The job record's destination is encrypted with the backup-service key (AES-GCM),
    // which the client-service cannot decrypt. Go through the destination table instead.
    const config = await getBackupConfigById(job.backupConfigId);
    if (!config?.destinationId) {
        makeResponse(req, res, 500, false, 'destination_config_unavailable');
        return;
    }
    const destination = await getDestinationById(config.destinationId);
    if (!destination) {
        makeResponse(req, res, 500, false, 'destination_config_unavailable');
        return;
    }
    const destConfig = getDecryptedDestinationConfig(destination);

    const s3Cfg = {
        bucketName: destConfig.bucketName,
        region: destConfig.region,
        accessKeyId: destConfig.accessKeyId,
        secretAccessKey: destConfig.secretAccessKey,
    };

    const prefix = targetObj.recordErrorsS3Prefix;
    const allKeys = await listS3Keys(s3Cfg, prefix);

    // totalRecords = sum of (BATCH_SIZE * all-but-last files) + rows in last file.
    // We approximate with allKeys.length * BATCH_SIZE and clip on the last page —
    // the actual row count is returned after reading the file.
    const globalOffset = (pageNum - 1) * PAGE_SIZE;
    const fileIdx = Math.floor(globalOffset / BATCH_SIZE);

    if (fileIdx >= allKeys.length) {
        makeResponse(req, res, 200, true, 'fetch', { records: [], totalRecords: allKeys.length * BATCH_SIZE, totalPages: Math.ceil((allKeys.length * BATCH_SIZE) / PAGE_SIZE), page: pageNum });
        return;
    }

    const fileText = await getS3Text(s3Cfg, allKeys[fileIdx]);
    const rows = fileText.split('\n').filter(l => l.trim());
    // rows[0] is the CSV header (recordId,error)
    const dataRows = rows.slice(1);

    const inFileOffset = globalOffset % BATCH_SIZE;
    const pageSlice = dataRows.slice(inFileOffset, inFileOffset + PAGE_SIZE);

    const records = pageSlice.map(row => {
        const commaIdx = row.indexOf(',');
        if (commaIdx === -1) return { recordId: row, error: '' };
        const recordId = row.slice(0, commaIdx);
        let error = row.slice(commaIdx + 1);
        // strip surrounding JSON quotes added during write
        try { error = JSON.parse(error); } catch { /* leave as-is */ }
        return { recordId, error };
    });

    // Compute accurate totalRecords: (files - 1) * BATCH_SIZE + dataRows.length of last file
    // We only know the current file's row count; for the last file use dataRows.length.
    const isLastFile = fileIdx === allKeys.length - 1;
    const totalRecords = isLastFile
        ? fileIdx * BATCH_SIZE + dataRows.length
        : allKeys.length * BATCH_SIZE; // upper-bound until last page is visited
    const totalPages = Math.ceil(totalRecords / PAGE_SIZE);

    makeResponse(req, res, 200, true, 'fetch', { records, totalRecords, totalPages, page: pageNum });
};

export const archivalConfigController = wrapController({
    getObjectChildHanlder,
    getFieldsHanlder,
    getObjectRecordsHanlder,
    listArchivalConfigsHandler,
    createArchivalConfigHandler,
    getArchivalConfigHandler,
    updateArchivalConfigHandler,
    deletearchivalConfigHandler,
    getArchivalJobStatsHandler,
    dryRunArchivalHandler,
    validateSoqlArchivalHandler,
    getRecordErrorsHandler,
});