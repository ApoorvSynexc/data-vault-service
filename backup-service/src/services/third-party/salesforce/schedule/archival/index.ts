import { OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares/logger';
import { IBackupObject, IDestinationConfig } from '../../../../../models';
import { recursivelyUpdateObjects, updateArchivalObject } from '../../../../backup-job';
import {
    buildS3KeyPrefix,
    buildSchemaS3Key,
    toParquetDataType,
} from '../../../../../utils/helper';
import { uploadToS3 } from '../../../../destination/s3';
import {
    createBulkQueryJob,
    getObjectMetadata,
} from '../../bulk';
import {
    pollBulkJobArchival,
    uploadBulkResultsByPageArchival,
} from './bulk';
import { SalesforceTokens } from '../../api-request';
import { getBackupConfigById, updateBackupConfig } from '../../../../backup-config';

// SOQL injection guards.
// Field names:  standard Salesforce API name (e.g. "Account", "Owner.Name")
// Operators:    must be one of the Joi-validated enum values
// Values:       allow the character set needed for SOQL literals
//               (quoted strings, numbers, dates, booleans, IN lists)
//               while blocking SQL/SOQL meta-characters like ; ` -- /* */
// Expression:   CUSTOM expressions must only contain index numbers,
//               whitespace, parentheses, and the keywords AND / OR / NOT
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;
const SAFE_VALUE_RE = /^[\w\s.'@%(),:.+-]+$/;
const ALLOWED_OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN']);

const isDateTimeFormat = (value: string): boolean => {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{3})?Z?$/.test(value);
};

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

    // If value is not already quoted and not a number/boolean/datetime, wrap it in single quotes
    let formattedValue = value;
    if (isDateTimeFormat(value)) {
        formattedValue = new Date(value).toISOString();
    } else if (!value.startsWith("'") && !value.startsWith('(') && isNaN(Number(value)) && value !== 'true' && value !== 'false') {
        formattedValue = `'${value}'`;
    }

    return `${name} ${operator} ${formattedValue}`;
};

// Build a SOQL WHERE clause from an object's field filters + condition.
// Fields are 1-indexed (field[0] -> "1", field[1] -> "2", ...).
// Only fields that have a filter contribute to the WHERE clause.
// AND/OR  -> join all filter conditions with the given logical operator.
// CUSTOM  -> replace 1-based indexes in condition.expression with the
//            corresponding filter condition strings.
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

// Archive: export all records to storage and hard delete from Salesforce
export const archiveAndHardDelete = async (
    backupConfigId: string,
    backupJobId: string,
    instanceUrl: string,
    tokens: SalesforceTokens,
    crmName: string,
    object: IBackupObject,
    destConfig: IDestinationConfig
): Promise<void> => {
    const { crmId } = tokens;
    const objectName = object.name;
    let backupConfig;
    let salesforceApiCount: number = 0;
    let totalRecordCount: number = 0;
    let jobId: string;
    let latestObjects: IBackupObject[] = [];

    try {
        const { fieldNames: allFieldNames, schema } = await getObjectMetadata(crmId, objectName);

        if (object.bulkJobId) {
            jobId = object.bulkJobId;
            salesforceApiCount += object.salesforceApiCount ?? 0;
        } else {
            latestObjects = await updateArchivalObject({
                backupJobId,
                object: {
                    id: object.id,
                    status: OBJECT_STATUS.bulkQueryInProgress
                }
            });

            const whereClause = buildWhereClause(object);
            const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName}${whereClause ? ` ${whereClause}` : ''} ORDER BY Id ASC`;

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
                    salesforceApiCount
                });
            } catch (err: any) {
                throw new Error(`[poll-bulk-job] ${err.message}`, { cause: err });
            }

            latestObjects = await updateArchivalObject({
                backupJobId,
                objects: latestObjects,
                object: {
                    id: object.id,
                    salesforceApiCount,
                    status: OBJECT_STATUS.bulkQueryCompleted,
                    bulkJobId: jobId,
                }
            });
        }

        logger.info(`Object found records for archival, backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectId:${object.id} objectName:${objectName} recordCount:${totalRecordCount}`);
        if (salesforceApiCount) {
            const archivePrefix = buildS3KeyPrefix(crmId, crmName, backupConfigId, objectName, 'inserts');
            const { sizeInBytes } = await uploadBulkResultsByPageArchival({
                instanceUrl,
                tokens,
                jobId,
                backupJobId,
                object,
                destConfig,
                salesforceApiCount,
                s3KeyPrefix: archivePrefix,
                startLocator: object.currentLocator ?? null,
                startCompletedRecordCount: object.completedRecordCount ?? 0,
            });

            const updateParams: any = { sizeInBytes };
            backupConfig = await getBackupConfigById(backupConfigId);
            if (backupConfig?.objects) {
                const updatedObjects = await recursivelyUpdateObjects(backupConfig.objects, { id: object.id, sizeInBytes });
                updateParams.sizeInBytes = (backupConfig.sizeInBytes ?? 0) + sizeInBytes;
                updateParams.objects = updatedObjects;
            }
            await updateBackupConfig(backupConfigId, updateParams);
        }

        const schemaWithParquet = schema.map((field: { dataType: string }) => ({
            ...field,
            parquetDataType: toParquetDataType(field.dataType),
        }));
        const schemaKey = buildSchemaS3Key(crmId, crmName, backupConfigId, objectName);
        await uploadToS3(
            destConfig,
            schemaKey,
            Buffer.from(JSON.stringify(schemaWithParquet, null, 2))
        );

        logger.info(`Object archival complete, backupConfigId:${backupConfigId}, backupJobId${backupJobId} objectId:${object.id} objectName:${objectName} recordCount:${totalRecordCount}`);
    } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        latestObjects = await updateArchivalObject({
            backupJobId,
            objects: latestObjects,
            object: {
                id: object.id,
                salesforceApiCount,
                status: OBJECT_STATUS.failed,
                errorMessage: errorMsg,
            }
        });
        logger.error(`Object archival failed, backupConfigId:${backupConfigId} backupJobId:${backupJobId} objectName:${objectName} - ${errorMsg}`);
        throw err;
    }
};
