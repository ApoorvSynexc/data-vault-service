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
    getCrmTokens,
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
import { buildOwnWhereBody, buildChildWhereBody } from "../../../services/third-party/salesforce/dry-run/soql-builder";
import { ICondition, IFieldFilter } from "../../../services/third-party/salesforce/dry-run/types";
import { listS3Keys, getS3Text } from "../../../utils/validate-aws-credentials";

// ── Parent chain types ────────────────────────────────────────────────────────

interface ParentFilters {
    condition: ICondition | null;
    fields: IFieldFilter[] | null;
}

interface ParentNode {
    apiName: string;
    referenceName: string;
    filters: ParentFilters;
    parent?: ParentNode;
}

interface ObjectRecordsBody {
    crmId: string;
    apiName: string;
    fields: string[];
    referenceName?: string;
    parent?: ParentNode;
    objectConfig?: object;
}

// ── WHERE clause builder ──────────────────────────────────────────────────────
// Flattens the nested parent chain (outermost = immediate parent, innermost = root),
// reverses it to root-first order, builds the root's own WHERE body, then
// transforms it outward through each ancestor using buildChildWhereBody.
//
// Returns null when the root has no filter conditions (fields is null and condition
// has no soqlQuery), which signals the caller to omit the whereClause entirely.

// Converts a FK field name to its SOQL relationship traversal name.
// "AccountId"  → "Account"   (strip trailing "Id")
// "Trainer__c" → "Trainer__r" (replace "__c" with "__r")
// "WhatId"     → "What"      (strip trailing "Id")
const toRelationshipName = (fieldApiName: string): string => {
    if (fieldApiName.endsWith('__c')) return `${fieldApiName.slice(0, -3)}__r`;
    if (fieldApiName.endsWith('Id')) return fieldApiName.slice(0, -2);
    return fieldApiName;
};

const buildWhereClauseFromParentChain = (parent: ParentNode, childReferenceName?: string): string | null => {
    const chain: ParentNode[] = [];
    let node: ParentNode | undefined = parent;
    while (node) {
        chain.push(node);
        node = node.parent;
    }
    // chain[0] = immediate parent (outermost), chain[last] = root (innermost)
    chain.reverse(); // now root-first: [root, level1, ..., immediate-parent]

    const root = chain[0];
    const rootWhereBody = buildOwnWhereBody({
        condition: root.filters.condition ?? undefined,
        field: root.filters.fields ?? undefined,
    });

    // Direct child of root (chain has only the root as parent):
    // use buildChildWhereBody to translate root's WHERE into the child's FK field.
    // e.g. root WHERE "Id != null" + childReferenceName "AccountId" → "AccountId != null"
    if (chain.length === 1) {
        if (!childReferenceName) { return rootWhereBody; }
        if (!rootWhereBody) { return `${childReferenceName} != null`; }
        return buildChildWhereBody(rootWhereBody, childReferenceName);
    }

    // Multiple levels deep: build a dotted SOQL traversal path.
    //
    // The chain contains only parent nodes (root → ... → immediate parent).
    // childReferenceName is the FK on the requested object itself (e.g. "WhatId").
    //
    // Example:
    //   chain  = [Account, Contact, Pok_mon__c]  (root-first)
    //   childReferenceName = "WhatId"  (ContactRequest's own FK)
    //
    //   childReferenceName "WhatId"     → toRelName → "What"       (outermost traversal)
    //   chain[2].referenceName "Trainer__c" → toRelName → "Trainer__r" (middle traversal)
    //   chain[1].referenceName "AccountId"                              (terminal FK field)
    //
    // Result: "What.Trainer__r.AccountId != null"

    const traversalParts: string[] = [];

    // Outermost: the requested child object's own FK → relationship name
    if (childReferenceName) {
        traversalParts.push(toRelationshipName(childReferenceName));
    }

    // Intermediate ancestors (chain[last] down to chain[2]): relationship names
    for (let i = chain.length - 1; i >= 2; i--) {
        traversalParts.push(toRelationshipName(chain[i].referenceName));
    }

    // Terminal: chain[1].referenceName is the FK column on root's immediate child — kept as-is
    traversalParts.push(chain[1].referenceName);

    const fieldPath = traversalParts.join('.');
    return `${fieldPath} != null`;
};


const getObjectChildHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName, mode } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const [apexResult] = await Promise.all([
        getApexObjectChilds(String(crmId), String(objectName), mode ? String(mode) : undefined),
    ]);

    makeResponse(req, res, 200, true, 'fetch', { ...apexResult });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName, mode } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }
    if (!objectName) {
        return makeResponse(req, res, 400, false, 'object_name_required');
    }
    const result = await getApexFields(String(crmId), String(objectName), mode ? String(mode) : undefined);
    makeResponse(req, res, 200, true, 'fetch', result);
};

const getObjectRecordsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, apiName, fields, referenceName, parent, objectConfig } = req.body as ObjectRecordsBody;

    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    if (!apiName) {
        return makeResponse(req, res, 400, false, 'params_required');
    }

    let whereClause: string | undefined;

    if (parent) {
        // Child object — derive WHERE clause by transforming the parent chain
        const whereBody = buildWhereClauseFromParentChain(parent, referenceName);
        if (whereBody) { whereClause = whereBody; }
    } else if (objectConfig) {
        // Root object — build WHERE clause directly from its own condition/fields
        const whereBody = buildOwnWhereBody(objectConfig as Parameters<typeof buildOwnWhereBody>[0]);
        if (whereBody) { whereClause = whereBody; }
    }

    const apexResult = await getApexObjectRecords(crmId, {
        apiName,
        fields,
        ...(whereClause && { whereClause }),
    });

    makeResponse(req, res, 200, true, 'fetch', apexResult);
};

// Computes per-row aggregate stats (records archived, bytes archived) by
// walking that config's archival job history. Adds `archivedRecordsCount` +
// `archivedSizeInBytes` to each row in place. Runs in parallel across rows
// so list latency is bounded by the slowest single config, not the sum.
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
    const { pagination, limit, cursor } = req.query as Record<string, string>;
    const spaceId = req.user?.spaceId;
    const userId = req.user!.userId;

    if (pagination === 'true') {
        const limitNum = Math.max(1, parseInt(limit ?? '10', 10));
        const { search, status, backupStatus } = req.query as Record<string, string>;

        const result = await getBackupConfigsWithPagination(
            {
                userId,
                type: 'ARCHIVAL',
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

    await attachArchivalStatsToRows(documents);

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
            await triggerArchivalBackupJob(config, immediateObjects);
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
    if (updated && !updated.lastBackupAt) {
        const { immediateObjects } = filtereObjects(req.body?.objects || []);
        if (immediateObjects.length > 0) {
            await triggerArchivalBackupJob(updated, immediateObjects);
        }
    }

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

    if (config.backupStatus === BACKUP_STATUS.pending && config.status !== STATUS.paused) {
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