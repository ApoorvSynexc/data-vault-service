import { OBJECT_STATUS } from '../../../../../constant';
import { logger } from '../../../../../middlewares';
import {
  IBackupConfig,
  IBackupField,
  IBackupObject,
  IDestinationConfig,
  IS3ObjectKey,
  ISource,
} from '../../../../../models';
import {
  buildS3KeyPrefix,
  formatFieldValuesForSOQL,
  formatValueByDataType,
  withSystemFields,
} from '../../../../../utils/helper';
import { updateArchivalConfigObject } from '../../../../backup-config';
import { updateArchivalObject } from '../../../../backup-job';
import { createBulkQueryJob, SalesforceTokens } from '../../api-request';
import { salesforceMetadataHandler } from '../../metadata';
import { bulkDeleteRecords } from '../archival/delete-bulk';
import { pollBulkJobArchival, uploadBulkResultsByPage } from './bulk';

interface IArchiveObject {
  backupConfig: IBackupConfig;
  backupJobId: string;
  source: ISource;
  destConfig: IDestinationConfig;
  object: IBackupObject;
  parentWhereClause?: string;
  s3Keys?: IS3ObjectKey[];
  // The config's whole tracked Object List — narrows the childs metadata scan
  // to objects this archival config actually cares about. See runArchival.
  objectNames?: string[];
}

const MAX_RETRIES = 3;
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;
const ALLOWED_OPERATORS = new Set([
  '=',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  'LIKE',
  'IN',
  'NOT IN',
  'INCLUDES',
  'EXCLUDES',
]);
const DATE_LITERALS = new Set([
  'TODAY',
  'YESTERDAY',
  'TOMORROW',
  'LAST_WEEK',
  'THIS_WEEK',
  'NEXT_WEEK',
  'LAST_MONTH',
  'THIS_MONTH',
  'NEXT_MONTH',
  'LAST_90_DAYS',
  'NEXT_90_DAYS',
  'LAST_QUARTER',
  'THIS_QUARTER',
  'NEXT_QUARTER',
  'LAST_YEAR',
  'THIS_YEAR',
  'NEXT_YEAR',
  'LAST_FISCAL_QUARTER',
  'THIS_FISCAL_QUARTER',
  'NEXT_FISCAL_QUARTER',
  'LAST_FISCAL_YEAR',
  'THIS_FISCAL_YEAR',
  'NEXT_FISCAL_YEAR',
]);

const isDateLiteral = (value: string): boolean =>
  DATE_LITERALS.has(value.toUpperCase()) ||
  /^(LAST|NEXT)_N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS):\d+$/i.test(
    value
  );

// These all apply to a whole query, not to a boolean condition — a raw SOQL
// condition body gets wrapped inside `AND (...)`, so any of them would land
// inside that parenthesized expression and produce invalid SOQL. Caught here
// with a message naming the actual keyword, instead of letting it through to
// fail later with a parser error that points at an unrelated token.
const TOP_LEVEL_CLAUSE_RE =
  /\b(LIMIT|OFFSET|ORDER\s+BY|GROUP\s+BY|HAVING|USING\s+SCOPE|USER_MODE|SYSTEM_MODE|FOR\s+VIEW|FOR\s+REFERENCE)\b/i;
const assertNoTopLevelClauses = (body: string): void => {
  // Drop quoted string literals first so a legitimate value like
  // "Notes__c LIKE '%offset%'" isn't mistaken for the clause keyword.
  const withoutStringLiterals = body.replace(/'(?:[^']|'')*'/g, "''");
  const match = withoutStringLiterals.match(TOP_LEVEL_CLAUSE_RE);
  if (match) {
    const clause = match[1].toUpperCase().replace(/\s+/g, ' ');
    throw new Error(
      `SOQL condition cannot contain ${clause} — it applies to the whole query, not a filter condition. Remove it from your query.`
    );
  }
};

// Subqueries aren't supported in a filter condition here. Salesforce places
// several interacting restrictions on them — a semi-join can't FROM the same
// object as the outer query, can't be nested inside another semi-join, and
// its left operand can't traverse more than one relationship level — any of
// which a parent condition can innocently violate once it's propagated
// (relationship-prefixed) down to a child object in the archive hierarchy.
// Rejected outright, up front, with a clear message instead of letting a
// propagated query fail deep in a Dry Run or a real archive run with a
// confusing Salesforce error that doesn't even point at the real cause.
const SUBQUERY_RE = /\(\s*SELECT\b/i;
const assertNoSubqueries = (body: string): void => {
  const withoutStringLiterals = body.replace(/'(?:[^']|'')*'/g, "''");
  if (SUBQUERY_RE.test(withoutStringLiterals)) {
    throw new Error(
      `Subqueries are not supported in filter conditions — Salesforce's own restrictions on subquery nesting, object types, and relationship depth make them unreliable once this condition is applied across an archive hierarchy's parent/child objects. Use a direct field or relationship comparison instead (e.g. "Account.Name = 'X'").`
    );
  }
};

// Function calls (DISTANCE(), GEOLOCATION(), CALENDAR_YEAR(), ...) can take a
// field as an argument rather than "field <operator> value" — the only shape
// transformWhereBodyForChild's relationship-prefix rewrite understands when
// this condition propagates to a child object. A field used as a function
// argument passes through unrewritten and reaches the child as a bare column
// name that only exists on the parent. Rejected outright, same as
// subqueries and for the same reason: better a clear message here (at
// Validate Query, before Dry Run/execution ever sees it) than a confusing
// "no such column" once it's already propagated.
// IN/LIKE/INCLUDES/EXCLUDES are excluded from this check — they're legitimate
// operators followed by a parenthesized value list, not function calls. So
// are AND/OR/NOT — "Field = 'x' AND (Field2 = 'y' OR Field3 = 'z')" and
// "NOT (Field = 'x')" are ordinary boolean grouping/negation, not a function
// call either. None of these words can ever be a real field name (they're
// SOQL reserved words), so excluding them can't hide an actual bad field.
const KNOWN_OPERATOR_WORDS = new Set(['IN', 'LIKE', 'INCLUDES', 'EXCLUDES', 'AND', 'OR', 'NOT']);
const FUNCTION_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const assertNoFunctionCalls = (body: string): void => {
  const withoutStringLiterals = body.replace(/'(?:[^']|'')*'/g, "''");
  FUNCTION_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FUNCTION_CALL_RE.exec(withoutStringLiterals))) {
    if (!KNOWN_OPERATOR_WORDS.has(match[1].toUpperCase())) {
      throw new Error(
        `Function calls (e.g. ${match[1]}(...)) are not supported in filter conditions — a field passed as a function argument can't be reliably rewritten for a related child object. Use a direct field or relationship comparison instead (e.g. "Account.Name = 'X'").`
      );
    }
  }
};

const buildFilterCondition = (
  f: IBackupField & { filter: NonNullable<IBackupField['filter']> },
  preformattedValue: string
): string => {
  const { name, dataType } = f;
  const { value: rawValue, operator } = f.filter;

  if (!SAFE_FIELD_NAME_RE.test(name)) {
    throw new Error(`Invalid SOQL field name: "${name}"`);
  }
  if (!ALLOWED_OPERATORS.has(operator)) {
    throw new Error(`Disallowed SOQL operator: "${operator}"`);
  }

  if (operator === 'LIKE') {
    const escaped = rawValue.replace(/'/g, "''");
    const wrapped = escaped.includes('%') ? escaped : `%${escaped}%`;
    return `${name} LIKE '${wrapped}'`;
  }

  if (operator === 'IN' || operator === 'NOT IN') {
    const parts = rawValue
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return `${name} ${operator} (${parts.map((v) => formatValueByDataType(v, dataType)).join(', ')})`;
  }

  // Multi-Select Picklist membership test: Salesforce's own syntax is a
  // SINGLE quoted string with the candidate values semicolon-joined inside
  // it — Field INCLUDES ('A;B') — not a parenthesized list of separately
  // quoted literals the way IN's values are. The UI still submits the raw
  // value comma-separated like every other multi-value filter here; only the
  // wire format changes to match what Salesforce expects.
  if (operator === 'INCLUDES' || operator === 'EXCLUDES') {
    const parts = rawValue
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const joined = parts.map((v) => v.replace(/'/g, "''")).join(';');
    return `${name} ${operator} ('${joined}')`;
  }

  const ldt = dataType.toLowerCase();
  if ((ldt === 'date' || ldt === 'datetime') && isDateLiteral(rawValue)) {
    return `${name} ${operator} ${rawValue}`;
  }

  return `${name} ${operator} ${preformattedValue}`;
};

const buildWhereClause = (object: IBackupObject): string => {
  const { field, condition } = object;
  if (!condition) {
    return '';
  }

  if ((condition as any).type === 'SOQL') {
    const soqlQuery: string = (condition as any).soqlQuery ?? '';
    const body = soqlQuery.trim().replace(/^WHERE\s+/i, '');
    if (body) {
      assertNoTopLevelClauses(body);
      assertNoSubqueries(body);
      assertNoFunctionCalls(body);
    }
    return body ? `WHERE ${body}` : '';
  }

  if (!field?.length) {
    return '';
  }

  const formattedFields = formatFieldValuesForSOQL(field);

  const filterMap = new Map<number, string>();
  field.forEach((f, idx) => {
    if (f.filter) {
      const preformattedValue =
        (formattedFields[idx] as typeof f)?.filter?.value ??
        formatValueByDataType(f.filter.value, f.dataType);
      filterMap.set(
        idx + 1,
        buildFilterCondition(
          f as IBackupField & { filter: NonNullable<IBackupField['filter']> },
          preformattedValue
        )
      );
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

// The keyword-operator branch ends on \b (a zero-width word boundary), not a
// literal \s — free-text SOQL commonly omits the space before the opening
// paren ("not in('x')", "excludes('x')"), and requiring a consumed whitespace
// character there made the whole match (and the relationship-prefix rewrite
// it drives) silently fail whenever the user didn't type that space.
const FIELD_REF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*(?:!=|>=|<=|=|>|<)|\s+(?:NOT\s+IN|INCLUDES|EXCLUDES|IN|LIKE)\b)/gi;

function transformWhereBodyForChild(whereBody: string, fkFieldName: string): string {
  if (!whereBody.trim()) {
    return `${fkFieldName} != null`;
  }
  const relName = fkToRelationshipName(fkFieldName);
  // Capture field references (identifier chains) immediately followed by a SOQL
  // comparison operator. Ignores quoted string values and AND/OR/NOT keywords.
  return whereBody.replace(FIELD_REF_RE, (_match, field, op) => {
    if (field === 'Id') {
      return `${fkFieldName}${op}`;
    }
    return `${relName}.${field}${op}`;
  });
}

const archiveObject = async (payload: IArchiveObject) => {
  const { backupConfig, backupJobId, source, destConfig, object, s3Keys, objectNames } = payload;
  const { access_token, refresh_token, instanceUrl, crmId, crmName } = source;
  const backupConfigId = backupConfig.backupConfigId;
  const tokens: SalesforceTokens = {
    accessToken: access_token,
    refreshToken: refresh_token,
    crmId,
    backupConfigId,
  };
  const objectName = object.name;
  let jobId: string;
  let salesforceApiCount = 0;
  let totalRecordCount = 0;
  let parentWhereClause = payload.parentWhereClause || '';

  try {
    const fieldsMetadata = await salesforceMetadataHandler(
      {
        metadataType: 'fields',
        policyConfigType: 'archival',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );

    if (!fieldsMetadata?.fields) {
      return;
    }

    const fieldNames: string[] = [];
    const excludeName = ['ownerid', 'createdbyid', 'lastmodifiedbyid', 'fromid'];
    fieldsMetadata.fields.forEach((f) => {
      if (
        f.referenceTo.length > 1 &&
        !excludeName.includes(f.name.toLowerCase()) &&
        f.name.toLowerCase().includes('id')
      ) {
        const nameWithType = f.name.toLowerCase().replace('id', '.type');
        fieldNames.push(nameWithType);
      }
      fieldNames.push(f.name);
    });

    const allFieldNames = withSystemFields(fieldNames);
    // Same schema-metadata set the backup flow stores (fields already ran
    // above) — picklist values, record types, and child relationships,
    // scoped to this config's own Object List via objectNames.
    await salesforceMetadataHandler(
      {
        metadataType: 'picklist',
        policyConfigType: 'archival',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );
    await salesforceMetadataHandler(
      {
        metadataType: 'recordTypes',
        policyConfigType: 'archival',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );
    await salesforceMetadataHandler(
      {
        metadataType: 'childs',
        policyConfigType: 'archival',
        backupConfig,
        backupJobId,
        crmId,
        crmName,
        objectNames,
        object,
        isInitialBackup: true,
      },
      { instanceUrl, tokens }
    );

    if (object.bulkJobId) {
      jobId = object.bulkJobId;
      salesforceApiCount += object.salesforceApiCount ?? 0;
    } else {
      await updateArchivalObject({
        backupJobId,
        object: {
          id: object.id,
          salesforceApiCount: 1,
          status: OBJECT_STATUS.bulkQueryInProgress,
        },
      });

      if (parentWhereClause) {
        const transformedWhere = transformWhereBodyForChild(
          parentWhereClause,
          (object as any).fieldApiName
        );
        parentWhereClause = transformedWhere;
        // parentWhereClause += ` AND ${transformedWhere}`
      } else {
        parentWhereClause = buildWhereClause(object);
      }

      const whereBody = parentWhereClause.replace(/^WHERE\s+/i, '').trim();
      const archivalWhere = whereBody
        ? `WHERE IsDeleted = false AND (${whereBody})`
        : 'WHERE IsDeleted = false';
      const soql = `SELECT ${allFieldNames.join(', ')} FROM ${objectName} ${archivalWhere} WITH USER_MODE ORDER BY Id ASC`;

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

      const { sizeInBytes, completedRecordCount } = await uploadBulkResultsByPage({
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

      await updateArchivalConfigObject({
        backupConfigId,
        object: {
          id: object.id,
          completedRecordCount,
          sizeInBytes,
        },
      });
    }

    if (object.children?.length) {
      for (let index = 0; index < object.children.length; index++) {
        const childObject = object.children[index];
        try {
          await exportWithRetryArchivalV2({
            type: 'backup',
            backupConfig,
            backupJobId,
            source,
            destConfig,
            object: childObject,
            parentWhereClause,
            s3Keys,
            objectNames,
          });
        } catch (error: any) {
          logger.error(
            `Archival job ${backupJobId}: failed to export ${childObject.name} - ${error?.message}`
          );
          await updateArchivalObject({
            backupJobId,
            object: {
              id: childObject.id,
              status: OBJECT_STATUS.failed,
              errorMessage: `parent ${objectName} export failed: ${error?.message}`,
            },
          });
        }
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

const deleteObjectRecords = async (payload: IArchiveObject): Promise<string> => {
  const { backupConfig, backupJobId, source, destConfig, object, s3Keys } = payload;

  let anyChildFailed = false;

  if (payload.object.children?.length) {
    for (let index = 0; index < payload.object.children.length; index++) {
      const childObject = payload.object.children[index];
      try {
        const childStatus = await exportWithRetryArchivalV2({
          type: 'delete',
          backupConfig,
          backupJobId,
          source,
          destConfig,
          object: childObject,
          s3Keys,
        });

        if (childStatus !== OBJECT_STATUS.completed) {
          // Child didn't fully delete (some records rejected by Salesforce). Keep
          // going on remaining siblings, but remember to block the parent below —
          // deleting it now would let Salesforce cascade-delete this child's
          // leftovers itself, which is what trips DELETE_OPERATION_TOO_LARGE.
          anyChildFailed = true;
          logger.error(
            `Archival job ${payload.backupJobId}: child ${childObject.name} did not fully delete (status=${childStatus}) - will block delete of ${object.name}`
          );
        }
      } catch (error: any) {
        anyChildFailed = true;
        logger.error(
          `Archival job ${payload.backupJobId}: failed to delete ${childObject.name} - ${error?.message}`
        );
        await updateArchivalObject({
          backupJobId: payload.backupJobId,
          object: {
            id: childObject.id,
            status: OBJECT_STATUS.failed,
            errorMessage: `parent ${payload.object.name} delete failed: ${error?.message}`,
          },
        });
      }
    }
  }

  if (anyChildFailed) {
    const blockedMessage = `blocked: one or more children did not fully delete`;
    await updateArchivalObject({
      backupJobId,
      object: {
        id: object.id,
        status: OBJECT_STATUS.deletionJobFailed,
        errorMessage: blockedMessage,
      },
    });
    return OBJECT_STATUS.deletionJobFailed;
  }

  const backupConfigId = backupConfig.backupConfigId;
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
        status: OBJECT_STATUS.deletionInProgress,
      },
    });

    const status = await bulkDeleteRecords({
      backupJobId: backupJobId,
      backupConfigId: backupConfigId,
      crmId: source.crmId,
      crmName: source.crmName,
      instanceUrl: source.instanceUrl,
      tokens,
      object: object,
      destConfig,
      s3Urls,
    });

    // await updateArchivalObject({
    //   backupJobId,
    //   object: {
    //     id: object.id,
    //     status: OBJECT_STATUS.completed,
    //   },
    // });

    return status;
  } catch (error: any) {
    logger.error(
      `Archival job ${backupJobId}: failed to delete ${object.name} - ${error?.message}`
    );
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

const exportWithRetryArchivalV2 = async (data: {
  type: 'backup' | 'delete';
  backupConfig: IBackupConfig;
  backupJobId: string;
  source: ISource;
  destConfig: IDestinationConfig;
  object: IBackupObject;
  parentWhereClause?: string;
  s3Keys?: IS3ObjectKey[];
  objectNames?: string[];
}): Promise<string | void> => {
  const { type, ...payload } = data;
  const objectName = payload.object.name;
  let lastError: any;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (type === 'backup') {
        await archiveObject(payload);
        return;
      }
      return await deleteObjectRecords(payload);
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

export { exportWithRetryArchivalV2 };
