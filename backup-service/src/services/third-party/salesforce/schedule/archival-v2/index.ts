import { OBJECT_STATUS } from "../../../../../constant";
import { logger } from "../../../../../middlewares";
import { IBackupObject, IDestinationConfig, IS3ObjectKey, ISource } from "../../../../../models";
import { buildS3KeyPrefix } from "../../../../../utils/helper";
import { updateArchivalObject } from "../../../../backup-job";
import { createBulkQueryJob, SalesforceTokens } from "../../api-request";
import { salesforceMetadataHandler } from "../../metadata";
import { bulkDeleteRecords } from "../archival/delete-bulk";
import { pollBulkJobArchival, uploadBulkResultsByPage } from "./bulk";

interface IArchiveObject {
    backupConfigId: string,
    backupJobId: string,
    source: ISource,
    destinationType: string,
    destConfig: IDestinationConfig,
    object: IBackupObject,
    parentWhereClause?: string
    s3Keys?: IS3ObjectKey[]
}

const MAX_RETRIES = 3;
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;
const SAFE_VALUE_RE = /^[\w\s.'@%(),:.+-]+$/;
const ALLOWED_OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN']);

const EXCLUDED_FIELD_TYPES = new Set(['address', 'location', 'base64']);
const EXCLUDED_FIELD_NAMES = new Set(['InformalName']);
const isQueryableField = (f: { name: string; type: string }): boolean =>
    !EXCLUDED_FIELD_NAMES.has(f.name) && !EXCLUDED_FIELD_TYPES.has(f.type);

const buildFilterCondition = (name: string, operator: string, value: string): string => {
    if (!SAFE_FIELD_NAME_RE.test(name)) {
        throw new Error(`Invalid SOQL field name: "${name}"`);
    }
    if (!ALLOWED_OPERATORS.has(operator)) {
        throw new Error(`Disallowed SOQL operator: "${operator}"`);
    }
    if (!SAFE_VALUE_RE.test(value)) {
        throw new Error(`Invalid SOQL filter value: "${value}"`);
    }

    // If value is not already quoted and not a number/boolean, wrap it in single quotes
    let formattedValue = value;
    if (
        !value.startsWith("'") &&
        !value.startsWith('(') &&
        isNaN(Number(value)) &&
        value !== 'true' &&
        value !== 'false'
    ) {
        formattedValue = `'${value}'`;
    }

    return `${name} ${operator} ${formattedValue}`;
};

const buildWhereClause = (object: IBackupObject): string => {
    const { field, condition } = object;
    if (!field?.length || !condition) {
        return '';
    }

    const filterMap = new Map<number, string>();
    field.forEach((f, idx) => {
        if (f.filter) {
            filterMap.set(idx + 1, buildFilterCondition(f.name, f.filter.operator, f.filter.value));
        }
    });

    if (filterMap.size === 0) {
        return '';
    }

    if (condition.type === 'CUSTOM' && condition.expression) {
        const stripped = condition.expression.replace(/\b(AND|OR|NOT)\b/gi, ' ');
        if (!/^[\d\s()]+$/.test(stripped)) {
            throw new Error(`Invalid SOQL custom expression: "${condition.expression}"`);
        }

        let expr = condition.expression;
        const sorted = Array.from(filterMap.entries()).sort((a, b) => b[0] - a[0]);
        for (const [idx, cond] of sorted) {
            expr = expr.replace(new RegExp(`\\b${idx}\\b`, 'g'), cond);
        }
        return `WHERE ${expr}`;
    }

    const separator = condition.type === 'OR' ? ' OR ' : ' AND ';
    return `WHERE ${Array.from(filterMap.values()).join(separator)}`;
};

function fkToRelationshipName(fieldApiName: string): string {
    if (fieldApiName.endsWith('__c')) {
        return `${fieldApiName.slice(0, -3)}__r`;
    }
    if (fieldApiName.endsWith('Id')) {
        return fieldApiName.slice(0, -2);
    }
    return fieldApiName;
}

function transformWhereBodyForChild(whereBody: string, fkFieldName: string): string {
    if (!whereBody.trim()) {
        return `${fkFieldName} != null`;
    }
    const relName = fkToRelationshipName(fkFieldName);
    // Capture field references (identifier chains) immediately followed by a SOQL
    // comparison operator. Ignores quoted string values and AND/OR/NOT keywords.
    return whereBody.replace(
        /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*(?:!=|>=|<=|=|>|<)|\s+(?:NOT\s+IN|IN|LIKE)\s)/gi,
        (_match, field, op) => {
            if (field === 'Id') {
                return `${fkFieldName}${op}`;
            }
            return `${relName}.${field}${op}`;
        }
    );
}

const archiveObject = async (
    payload: IArchiveObject
) => {
    const { backupConfigId, backupJobId, source, destinationType, destConfig, object, s3Keys } = payload;
    const { access_token, refresh_token, instanceUrl, crmId, crmName } = source;
    const tokens: SalesforceTokens = {
        accessToken: access_token,
        refreshToken: refresh_token,
        crmId,
        backupConfigId,
    };
    const objectName = object.name;
    let jobId = backupJobId;
    let salesforceApiCount = 0;
    let totalRecordCount = 0;
    let parentWhereClause = payload.parentWhereClause || '';

    try {
        const fieldsMetadata = await salesforceMetadataHandler({
            metadataType: 'fields',
            policyConfigType: 'backup',
            backupConfigId,
            backupJobId,
            crmId,
            crmName,
            objectName,
            isInitialBackup: true,
        }, { instanceUrl, tokens });
        const allFieldNames =
            fieldsMetadata?.metadataType === 'fields'
                ? fieldsMetadata.fields.filter(isQueryableField).map((f) => f.name)
                : [];


        if (object.bulkJobId) {
            jobId = object.bulkJobId;
            salesforceApiCount += object.salesforceApiCount ?? 0;
        } else {
            await updateArchivalObject({
                backupJobId,
                object: {
                    id: object.id,
                    salesforceApiCount: 1,
                    status: OBJECT_STATUS.bulkQueryInProgress
                },
            });

            const whereClause = buildWhereClause(object);
            if (parentWhereClause) {
                const transformedWhere = transformWhereBodyForChild(whereClause, (object as any).fieldApiName);
                parentWhereClause += ` AND ${transformedWhere}`
            } else {
                parentWhereClause = whereClause;
            }

            const whereBody = whereClause.replace(/^WHERE\s+/i, '').trim();
            const archivalWhere = whereBody
                ? `WHERE IsDeleted = false AND (${whereBody})`
                : 'WHERE IsDeleted = false';
            const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName} ${archivalWhere} ORDER BY Id ASC`;

            try {
                jobId = await createBulkQueryJob({ instanceUrl, tokens, soql });
                salesforceApiCount += 2;
            } catch (err: any) {
                throw new Error(`[create-bulk-job] ${err.message}`, { cause: err });
            }

            try {
                totalRecordCount = await pollBulkJobArchival({
                    instanceUrl,
                    tokens,
                    jobId,
                    backupJobId,
                    object,
                });
            } catch (err: any) {
                throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
            }

            await updateArchivalObject({
                backupJobId,
                object: {
                    id: object.id,
                    salesforceApiCount: 1,
                    status: OBJECT_STATUS.bulkQueryCompleted,
                    bulkJobId: jobId,
                    totalRecordCount,
                },
            });
        }

        if (totalRecordCount === 0) {
            logger.info(
                `Archival object changes not found, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}`
            );
            await updateArchivalObject({
                backupJobId,
                object: {
                    id: object.id,
                    status: OBJECT_STATUS.completed,
                    completedRecordCount: 0,
                    errorMessage: '',
                },
            });
        } else {
            logger.info(
                `Archival object found records, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, Changes=${totalRecordCount}`
            );

            const s3KeyPrefix = buildS3KeyPrefix({
                crmId,
                crmName,
                backupConfigId,
                backupJobId,
                objectName,
                operation: 'inserts',
                type: 'archival',
            });

            await uploadBulkResultsByPage({
                instanceUrl,
                tokens,
                jobId,
                backupJobId,
                object,
                destConfig,
                s3KeyPrefix,
                salesforceApiCount,
                s3Keys,
                startLocator: object.currentLocator,
                startCompletedRecordCount: object.completedRecordCount ?? 0,
            });
        }

        if (object.children?.length) {
            for (let index = 0; index < object.children.length; index++) {
                const childObject = object.children[index];
                await exportWithRetryArchivalV2({
                    type: 'backup',
                    backupConfigId,
                    backupJobId,
                    source,
                    destinationType,
                    destConfig,
                    object: childObject,
                    parentWhereClause,
                    s3Keys,
                });
            }
        }
    } catch (error: any) {
        logger.error(`Archival job ${backupJobId}: failed to export ${objectName} - ${error?.message}`);
        await updateArchivalObject({
            backupJobId,
            object: {
                id: object.id,
                status: OBJECT_STATUS.failed,
                errorMessage: error?.message,
            },
        });
        throw error;
    }
};

const deleteObject = async (payload: IArchiveObject) => {
    const { backupConfigId, backupJobId, source, destConfig, object, s3Keys } = payload;
    const tokens: SalesforceTokens = {
        accessToken: source.access_token,
        refreshToken: source.refresh_token,
        crmId: source.crmId,
        backupConfigId,
    };
    const s3Urls = s3Keys?.filter((s3Key) => s3Key.objectId === object.id).map((s3Key) => s3Key.key);
    try {
        await updateArchivalObject({
            backupJobId,
            object: {
                id: object.id,
                status: OBJECT_STATUS.deletionInProgress
            },
        });

        await bulkDeleteRecords({
            backupJobId: backupJobId,
            backupConfigId: backupConfigId,
            crmId: source.crmId,
            crmName: source.crmName,
            instanceUrl: source.instanceUrl,
            tokens,
            object: object,
            destConfig,
            s3Urls
        });

        await updateArchivalObject({
            backupJobId,
            object: {
                id: object.id,
                status: OBJECT_STATUS.completed
            },
        });

    } catch (error: any) {
        logger.error(`Archival job ${backupJobId}: failed to delete ${object.name} - ${error?.message}`);
        await updateArchivalObject({
            backupJobId,
            object: {
                id: object.id,
                status: OBJECT_STATUS.deletionJobFailed,
                errorMessage: error?.message,
            },
        });
        throw error;
    }
};

const exportWithRetryArchivalV2 = async (
    data:
        {
            type: 'backup' | 'delete'
            backupConfigId: string,
            backupJobId: string,
            source: ISource,
            destinationType: string,
            destConfig: IDestinationConfig,
            object: IBackupObject,
            parentWhereClause?: string
            s3Keys?: IS3ObjectKey[]
        }
): Promise<void> => {
    const { type, ...payload } = data;
    const objectName = payload.object.name;
    let lastError: any;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (type === 'backup') {
                await archiveObject(payload);
            } else {
                await deleteObject(payload);
            }
            return;
        } catch (err: any) {
            lastError = err;
            if (attempt < MAX_RETRIES) {
                logger.warn(
                    `Archival job ${payload.backupJobId}: retrying ${objectName} (attempt ${attempt}/${MAX_RETRIES}) - ${err?.message}`
                );
            }
        }
    }

    throw lastError;
};

export {
    exportWithRetryArchivalV2
};