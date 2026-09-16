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
  // The object parentWhereClause was built for — needed if it contains a
  // subquery, which propagates by nesting through this object's own name
  // rather than by field-rewriting (see transformWhereBodyForChild).
  parentObjectName?: string;
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

// LIMIT/OFFSET/ORDER BY apply to a whole query, not to a boolean condition —
// a raw SOQL condition body gets wrapped inside `AND (...)`, so any of these
// would land inside that parenthesized expression and produce invalid SOQL.
// Caught here with a message naming the actual keyword, instead of letting it
// through to fail later with a parser error that points at an unrelated token.
const TOP_LEVEL_CLAUSE_RE = /\b(LIMIT|OFFSET|ORDER\s+BY)\b/i;
const assertNoTopLevelClauses = (body: string): void => {
  // Drop quoted string literals first so a legitimate value like
  // "Notes__c LIKE '%offset%'" isn't mistaken for the clause keyword.
  const withoutStringLiterals = body.replace(/'(?:[^']|'')*'/g, "''");
  const match = withoutStringLiterals.match(TOP_LEVEL_CLAUSE_RE);
  if (match) {
    throw new Error(
      `SOQL condition cannot contain ${match[1].toUpperCase()} — LIMIT/OFFSET/ORDER BY apply to the whole query, not a filter condition. Remove it from your query.`
    );
  }
};

// Salesforce SOQL has no correlated scalar subquery — the only place a
// subquery is legal is as the right-hand side of a semi-join, `field IN
// (SELECT relatedField FROM Child)` / `NOT IN (...)`. A subquery used as a
// bare value or comparison (e.g. "(SELECT COUNT() FROM X) > 0") isn't valid
// SOQL at all (Salesforce itself rejects it, not just this parser), but the
// parser's own error for it ("Expected identifier but found L_PAREN") reads
// like a bug in the query rather than an unsupported SOQL construct — this
// catches it earlier with a message that says what to do instead.
const SUBQUERY_OPEN_RE = /\(\s*SELECT\b/gi;
const SEMI_JOIN_PRECEDING_RE = /\b(?:NOT\s+)?IN\s*$/i;
const assertSubqueriesAreSemiJoins = (body: string): void => {
  const withoutStringLiterals = body.replace(/'(?:[^']|'')*'/g, "''");
  let match: RegExpExecArray | null;
  SUBQUERY_OPEN_RE.lastIndex = 0;
  while ((match = SUBQUERY_OPEN_RE.exec(withoutStringLiterals))) {
    const before = withoutStringLiterals.slice(0, match.index);
    if (!SEMI_JOIN_PRECEDING_RE.test(before)) {
      throw new Error(
        `Subqueries are only supported as "field IN (SELECT ...)" or "field NOT IN (SELECT ...)" — Salesforce SOQL doesn't support a subquery used directly as a value or comparison (e.g. "(SELECT COUNT() FROM X) > 0"). Rewrite it as an IN condition instead.`
      );
    }
  }
};

// Splits a WHERE body into alternating outside-subquery / subquery segments
// at the TOP level only (balanced-paren matched from each "(SELECT" that
// isn't itself inside another subquery) — a subquery segment's own inner
// text is left as one opaque block, not recursed into. Used both to keep
// the parent/child field-rewrite below from corrupting a subquery's own
// fields, and to check same-object violations only between a query and its
// DIRECT subqueries (matching Salesforce's restriction, which is pairwise
// between immediately nested selects, not transitive across every level).
function splitOutSubqueries(whereBody: string): Array<{ text: string; isSubquery: boolean }> {
  const segments: Array<{ text: string; isSubquery: boolean }> = [];
  const subqueryStartRe = /\(\s*SELECT\b/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = subqueryStartRe.exec(whereBody))) {
    if (match.index < cursor) {
      continue;
    }
    segments.push({ text: whereBody.slice(cursor, match.index), isSubquery: false });

    let depth = 0;
    let end = match.index;
    for (; end < whereBody.length; end++) {
      if (whereBody[end] === '(') {depth++;}
      else if (whereBody[end] === ')') {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    segments.push({ text: whereBody.slice(match.index, end), isSubquery: true });
    cursor = end;
    subqueryStartRe.lastIndex = end;
  }
  segments.push({ text: whereBody.slice(cursor), isSubquery: false });
  return segments;
}

const containsSubquery = (body: string): boolean =>
  splitOutSubqueries(body).some((segment) => segment.isSubquery);

// Salesforce rejects a semi-join whose subquery FROMs the same object as the
// query that directly contains it ("The inner and outer selects should not
// be on the same object type") — but only at actual query EXECUTION, not at
// `query?explain=` (the API "Validate Query" calls), so a query with this
// mistake passes validation and only fails later, in the Dry Run or the real
// archive run. Checked statically here so both paths catch it up front.
// Only checks DIRECT (top-level) subqueries against `outerObjectName` — a
// subquery nested inside another subquery is paired with ITS OWN immediate
// container, not this one, so it isn't examined here.
const SUBQUERY_FROM_RE = /\(\s*SELECT\b[\s\S]*?\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const assertSubqueryObjectDiffers = (body: string, outerObjectName: string): void => {
  const withoutStringLiterals = body.replace(/'(?:[^']|'')*'/g, "''");
  for (const segment of splitOutSubqueries(withoutStringLiterals)) {
    if (!segment.isSubquery) {continue;}
    const match = segment.text.match(SUBQUERY_FROM_RE);
    if (match && match[1].toLowerCase() === outerObjectName.toLowerCase()) {
      throw new Error(
        `Subquery cannot select FROM the same object ("${outerObjectName}") you're filtering — Salesforce doesn't allow a semi-join subquery on the same object type as the outer query. Use the relationship's lookup field directly instead, e.g. "LookupField__c IN (SELECT Id FROM RelatedObject WHERE ...)".`
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
      assertSubqueriesAreSemiJoins(body);
      assertSubqueryObjectDiffers(body, object.name);
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

const FIELD_REF_RE =
  /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*(?:!=|>=|<=|=|>|<)|\s+(?:NOT\s+IN|IN|LIKE)\s)/gi;

// Propagates a parent's WHERE body onto a child object. A plain condition
// (no subquery) is field-rewritten in place — cheaper, and lets Salesforce
// use a relationship-traversal filter instead of a semi-join. A condition
// containing a subquery can't be safely field-rewritten piecemeal (its
// subquery has its own independent FROM/field context — see
// assertSubqueryObjectDiffers's doc comment), so it's nested whole instead:
// the child's FK must point to a parent record that itself satisfies the
// original condition, unchanged. This also sidesteps a same-object
// violation that piecemeal rewriting could otherwise reintroduce — the
// nested subquery's own inner subquery (if any) is now paired against
// `parentObjectName`, not the child, since that's what directly contains it.
function transformWhereBodyForChild(
  whereBody: string,
  fkFieldName: string,
  parentObjectName: string
): string {
  if (!whereBody.trim()) {
    return `${fkFieldName} != null`;
  }

  if (containsSubquery(whereBody)) {
    return `${fkFieldName} IN (SELECT Id FROM ${parentObjectName} WHERE ${whereBody})`;
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
  let parentObjectName = payload.parentObjectName || '';

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
          (object as any).fieldApiName,
          parentObjectName
        );
        parentWhereClause = transformedWhere;
        // parentWhereClause += ` AND ${transformedWhere}`
      } else {
        parentWhereClause = buildWhereClause(object);
      }
      // This object's own effective where body is what its children (if any)
      // will inherit next, so it becomes THEIR parentObjectName.
      parentObjectName = objectName;

      const whereBody = parentWhereClause.replace(/^WHERE\s+/i, '').trim();
      // A same-object subquery violation can be introduced by propagation even
      // when the ancestor's own condition was fine on its own object — e.g. an
      // ancestor's subquery FROMs one of its own children, and that child then
      // inherits the condition and ends up querying itself. Re-checked here
      // against the object actually being archived, not just once against
      // whichever object originally owned the condition.
      if (whereBody) {
        assertSubqueryObjectDiffers(whereBody, objectName);
      }
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
            parentObjectName,
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
  // The object parentWhereClause was built for — needed if it contains a
  // subquery, which propagates by nesting through this object's own name
  // rather than by field-rewriting (see transformWhereBodyForChild).
  parentObjectName?: string;
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
