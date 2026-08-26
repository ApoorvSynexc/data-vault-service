import { BACKUP_CONFIG_TABLE, BACKUP_STATUS, BACKUP_TYPE, STATUS, SCHEDULE_TYPE } from "../../../constant";
import { IRequest, IResponse, makeResponse } from "../../../lib";
import { logger } from "../../../middlewares";
import {
    createBackupConfig,
    deleteBackupConfig,
    getApexFields,
    getApexPicklistValues,
    getUserForCrm,
    getApexObjectChilds,
    toApexType,
    getDestinationById,
    getBackupConfigsWithPagination,
    getCrmById,
    getTableCounter,
    buildBackupConfigCounterKey,
    getBackupConfigBySlug,
    getBackupConfigById,
    updateBackupConfig,
    deleteBackupJobsByConfig,
    computeArchivalJobStats,
    triggerArchivalBackupJob,
    getBackupJobById,
    getDecryptedDestinationConfig,
    unwrapApex,
    createAwsEventScheduler,
    updateAwsEventSchedule,
    deleteAwsEventScheduler,
} from "../../../services";
import { filtereObjects, isOwner, wrapController } from "../../../utils/helper";
import { buildArchivalObjectScheduleName, buildScheduleInput, computeNextScheduledRun } from "../../../utils/event-bridge";
import { dryRunV2 } from "../../../services/third-party/salesforce/dryrun-v2";
import { buildOwnWhereBody, buildChildWhereBody } from "../../../services/third-party/salesforce/dry-run/soql-builder";
import { ICondition, IFieldFilter } from "../../../services/third-party/salesforce/dry-run/types";
import { listS3Keys, getS3Text } from "../../../utils/validate-aws-credentials";
import { previewRecords } from "../../../services/third-party/salesforce/dryrun-v2/preview-records";
import { validateSoql } from "../../../services/third-party/salesforce/dryrun-v2/validate-soql";
import { generateSoqlQueries } from "../../../services/third-party/salesforce/dryrun-v2/soql-generation";

interface ObjectRecordsBody {
    id: string;
    name: string;
    fieldNames: string[]
    soql: string
}


const getObjectChildHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    // `type` is the schedule/realtime split; older clients sent it as `mode`.
    const { crmId, objectName, type, mode, relationshipDepth } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const [apexResult] = await Promise.all([
        getApexObjectChilds({ user, objectName: String(objectName), mode: 'archival', type: toApexType(type ?? mode), relationshipType: 'ALL', relationshipDepth: relationshipDepth ? Number(relationshipDepth) : undefined }),
    ]);

    makeResponse(req, res, 200, true, 'fetch', unwrapApex(apexResult));
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { crmId, objectName } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }
    if (!objectName) {
        return makeResponse(req, res, 400, false, 'object_name_required');
    }
    const result = await getApexFields({ user, objectName: String(objectName), mode: 'archival' });
    makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
};

// Same apex callout also exposed on /restore (see restore-retrieve controller) — shared logic lives in getApexPicklistValues.
const getPicklistFieldValuesHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectApiName, fieldApiName } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }
    if (!objectApiName || !fieldApiName) {
        return makeResponse(req, res, 400, false, 'params_required');
    }
    // A person can have one user record per connected CRM — resolve the record for this crmId.
    const crmUser = await getUserForCrm(req.user!, String(crmId));
    if (!crmUser) {
        return makeResponse(req, res, 400, false, 'not_exist');
    }
    const result = await getApexPicklistValues({ user: crmUser, objectApiName: String(objectApiName), fieldApiName: String(fieldApiName) });
    makeResponse(req, res, 200, true, 'fetch', unwrapApex(result));
};

const getObjectRecordsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { name, fieldNames, soql } = req.body as ObjectRecordsBody;

    const user = req.user;
    if (!user) {
        return makeResponse(req, res, 400, false, 'not_exist');
    }

    const result = await previewRecords({ user, objectName: name, fieldNames, soql });
    makeResponse(req, res, 200, true, 'fetch', result);
};

const attachArchivalStatsToRows = async (documents: any[]): Promise<void> => {
    await Promise.all(
        documents.map(async (document) => {
            try {
                const stats = await computeArchivalJobStats({
                    indexName: 'backupConfigId-index',
                    keyName: 'backupConfigId',
                    keyValue: document.backupConfigId,
                });
                document.archivedRecordsCount = stats.totalRecords;
                document.archivedSizeInBytes = stats.totalSize;
            } catch (err: any) {
                // Don't fail the whole list if one config's stats query throws.
                logger.warn(`Failed to compute archival stats for ${document.backupConfigId}: ${err?.message ?? err}`);
                document.archivedRecordsCount = 0;
                document.archivedSizeInBytes = 0;
            }
        })
    );
};

const listArchivalConfigsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { pagination, limit, cursor, name } = req.query as Record<string, string>;
    const crmId = req.user?.crmId;
    const userId = req.user!.userId;

    if (pagination === 'true') {
        const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
        const { search, status, backupStatus } = req.query as Record<string, string>;

        const result = await getBackupConfigsWithPagination(
            {
                userId,
                type: BACKUP_TYPE.archival,
                ...(search && search.length > 0 && { search }),
                ...(status && { status }),
                ...(backupStatus && { backupStatus }),
            },
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

        await attachArchivalStatsToRows(documents);
        const counter = await getTableCounter(BACKUP_CONFIG_TABLE, buildBackupConfigCounterKey(userId, BACKUP_TYPE.archival));

        return makeResponse(req, res, 200, true, 'fetch', documents, {
            limit: limitNum,
            nextCursor,
            totalRecords: counter?.count ?? 0,
            totalPages: Math.ceil((counter?.count ?? 0) / limitNum),
        });
    }

    const { documents } = await getBackupConfigsWithPagination(
        { ...(crmId ? { crmId } : { userId }), type: 'ARCHIVAL', name: name },
        { limit: 1000 }
    );

    await attachArchivalStatsToRows(documents);

    makeResponse(req, res, 200, true, 'fetch', documents);
};

const createArchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const destination = await getDestinationById(String(req.body.destinationId));
    const isOwner = destination && destination.userId === req.user!.userId;

    if (!isOwner) {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    const config = await createBackupConfig({
        userId: req.user!.userId,
        ...req.body,
        status: req.body.status || 'ACTIVE',
        type: BACKUP_TYPE.archival,
    });

    try {
        // Skip schedule/trigger setup if status is DRAFT
        if (config.status === 'DRAFT') {
            makeResponse(req, res, 201, true, 'create', config);
            return;
        }

        const { immediateObjects, scheduledObjects } = filtereObjects(req.body?.objects || []);
        if (immediateObjects.length > 0) {
            await triggerArchivalBackupJob({ user, config, objects: immediateObjects });
        }

        if (scheduledObjects.length) {
            for (let index = 0; index < scheduledObjects.length; index++) {
                const scheduledObject = scheduledObjects[index];

                const isOneTimeNonScheduled = scheduledObject.scheduleConfig?.type === SCHEDULE_TYPE.oneTime && !scheduledObject.scheduleConfig.scheduling?.startDate && !scheduledObject.scheduleConfig.scheduling?.startTime
                if (isOneTimeNonScheduled) {
                    continue;
                }

                await createAwsEventScheduler(
                    buildScheduleInput(
                        buildArchivalObjectScheduleName(scheduledObject.id),
                        scheduledObject.scheduleConfig!,
                        { backupConfigId: config.backupConfigId, userId: config.userId, id: scheduledObject.id }
                    )
                );
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
    const user = req.user;
    try {
        const result = await dryRunV2({ ...req.body, user });
        makeResponse(req, res, 201, true, 'create', result);
    } catch (error) {
        logger.error('Error running archival dry-run: ', error);
        throw error;
    }
};

const validateSoqlArchivalHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    if (!user) {
        return makeResponse(req, res, 400, false, 'not_exist');
    }

    const { object, isParent } = req.body as {
        object: { name: string; condition?: ICondition; field?: IFieldFilter[] };
        isParent: boolean;
    };

    // Children cannot carry their own filter conditions.
    if (!isParent) {
        if (object.condition || object.field?.length) {
            return makeResponse(req, res, 200, true, 'fetch', {
                isValid: false,
                error: 'Child objects cannot have filter conditions.',
            });
        }
        return makeResponse(req, res, 200, true, 'fetch', { isValid: true });
    }

    // No filter configured at all — nothing to validate against Salesforce.
    if (!object.condition) {
        return makeResponse(req, res, 200, true, 'fetch', { isValid: true });
    }

    const [{ soql }] = generateSoqlQueries([
        { id: object.name, name: object.name, type: 'STANDARD', condition: object.condition, field: object.field },
    ]);

    const result = await validateSoql({ user, soql });
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
    if (existing && (!isOwner(existing, user!.userId, user!.crmId) || existing.type !== 'ARCHIVAL')) {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    const updated = await updateBackupConfig(String(backupConfigId), req.body);
    if (updated && !updated.lastBackupAt) {
        const { immediateObjects, scheduledObjects } = filtereObjects(req.body?.objects || []);
        if (immediateObjects.length > 0) {
            await triggerArchivalBackupJob({ user, config: updated, objects: immediateObjects });
        }

        if (scheduledObjects.length) {
            for (let index = 0; index < scheduledObjects.length; index++) {
                const scheduledObject = scheduledObjects[index];

                const isOneTimeNonScheduled = scheduledObject.scheduleConfig?.type === SCHEDULE_TYPE.oneTime && !scheduledObject.scheduleConfig.scheduling?.startDate && !scheduledObject.scheduleConfig.scheduling?.startTime
                if (isOneTimeNonScheduled) {
                    continue;
                }

                await updateAwsEventSchedule(
                    buildScheduleInput(
                        buildArchivalObjectScheduleName(scheduledObject.id),
                        scheduledObject.scheduleConfig!,
                        { backupConfigId: updated.backupConfigId, userId: updated.userId, id: scheduledObject.id }
                    )
                );
            }
        }
    }

    makeResponse(req, res, 200, true, 'update', updated!);
};

const deletearchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { backupConfigId } = req.query;
    if (!backupConfigId) {
        return makeResponse(req, res, 400, false, 'id_required');
    }

    if (!user) {
        return makeResponse(req, res, 400, false, 'not_exist');
    }

    const existing = await getBackupConfigById(String(backupConfigId));
    const userId = req.user!.userId;

    const isConfigOwner = existing?.userId === userId;
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
        const { scheduledObjects } = filtereObjects(config.objects || []);
        if (scheduledObjects.length) {
            for (let index = 0; index < scheduledObjects.length; index++) {
                const scheduledObject = scheduledObjects[index];
                const isOneTimeNonScheduled = scheduledObject.scheduleConfig?.type === SCHEDULE_TYPE.oneTime && !scheduledObject.scheduleConfig.scheduling?.startDate && !scheduledObject.scheduleConfig.scheduling?.startTime
                if (isOneTimeNonScheduled) {
                    continue;
                }

                await deleteAwsEventScheduler(buildArchivalObjectScheduleName(scheduledObject.id));
            }
        }

        await Promise.all([
            deleteBackupConfig(String(backupConfigId)),
            deleteBackupJobsByConfig(String(backupConfigId), config.userId),
        ]);

        makeResponse(req, res, 200, true, 'delete');
    } catch (error) {
        throw error;
    }
};

// Archival scheduling is per-object (each scheduled object owns its own AWS
// schedule), unlike backup-config's one-schedule-per-config model — so "run now"
// here batch-triggers every currently eligible object in one shot. ONE_TIME
// eligibility still only has config.lastBackupAt as a proxy for "has this ever
// run" (no per-object run marker exists), so a mix of ONE_TIME + INCREMENTAL
// objects on one config can under/over-gate the ONE_TIME side.
const runNowArchivalConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const user = req.user;
    const { backupConfigId } = req.query;
    if (!backupConfigId) {
        makeResponse(req, res, 400, false, 'id_required');
        return;
    }

    const existing = await getBackupConfigById(String(backupConfigId));
    if (!existing || !isOwner(existing, user!.userId, user!.crmId) || existing.type !== 'ARCHIVAL') {
        makeResponse(req, res, 400, false, 'not_exist');
        return;
    }

    const { scheduledObjects } = filtereObjects(existing.objects || []);

    const oneTimePending = existing.lastBackupAt
        ? []
        : scheduledObjects.filter((obj) => obj.scheduleConfig?.type === SCHEDULE_TYPE.oneTime);
    // INCREMENTAL: always eligible, same as backup-config's ungated INCREMENTAL branch.
    const incrementalObjects = scheduledObjects.filter((obj) => obj.scheduleConfig?.type === SCHEDULE_TYPE.incremental);

    const objectsToRun = [...oneTimePending, ...incrementalObjects];
    if (!objectsToRun.length) {
        makeResponse(req, res, 400, false, 'job_already_invoked');
        return;
    }

    await triggerArchivalBackupJob({ user, config: existing, objects: objectsToRun });

    // A fired ONE_TIME object won't fire again — its AWS schedule is now dead weight.
    await Promise.all(
        oneTimePending.map((obj) => deleteAwsEventScheduler(buildArchivalObjectScheduleName(obj.id)))
    );

    // Informational only (same as backup-config's upcomingJob) — each INCREMENTAL
    // object owns its own schedule, so its skip note lives on the object itself
    // rather than a single config-level slot shared by every object.
    if (incrementalObjects.length) {
        const invokedIds = new Set(incrementalObjects.map((obj) => obj.id));
        const updatedObjects = (existing.objects ?? []).map((obj) => {
            if (!invokedIds.has(obj.id)) {
                return obj;
            }
            return {
                ...obj,
                upcomingJob: {
                    skip: true,
                    skipReason: 'Invoked immediately',
                    skipDateTime: computeNextScheduledRun(obj.scheduleConfig!).toISOString(),
                },
            };
        });
        await updateBackupConfig(existing.backupConfigId, { objects: updatedObjects });
    }

    makeResponse(req, res, 200, true, 'fetch');
};

const getArchivalJobStatsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { slug } = req.query;
    const userId = req.user!.userId;

    if (slug) {
        const config = await getBackupConfigBySlug({
            userId: req.user!.userId,
            slug: String(slug),
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

    const stats = await computeArchivalJobStats({ indexName: 'userId-index', keyName: 'userId', keyValue: userId });
    makeResponse(req, res, 200, true, 'fetch', stats);
};

const PAGE_SIZE = 10;
const BATCH_SIZE = 200; // records per S3 file

const getRecordErrorsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { backupJobId, objectId, page } = req.query as Record<string, string>;
    if (!backupJobId || !objectId) {
        makeResponse(req, res, 400, false, 'params_required');
        return;
    }

    const pageNum = Math.max(1, parseInt(page ?? '1', 10));

    const job = await getBackupJobById(backupJobId);
    if (!job || job.userId !== req.user!.userId) {
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
        try { error = JSON.parse(error); } catch { /* leave as-is */ }
        return { recordId, error };
    });

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
    getPicklistFieldValuesHandler,
    getObjectRecordsHanlder,
    listArchivalConfigsHandler,
    createArchivalConfigHandler,
    getArchivalConfigHandler,
    updateArchivalConfigHandler,
    deletearchivalConfigHandler,
    runNowArchivalConfigHandler,
    getArchivalJobStatsHandler,
    dryRunArchivalHandler,
    validateSoqlArchivalHandler,
    getRecordErrorsHandler,
});