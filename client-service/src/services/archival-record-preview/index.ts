import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { AWS_REGION, BACKUP_CONFIG_TABLE, BACKUP_TYPE } from '../../constant';
import { IBackupConfig, ICrm } from '../../models';
import { getCrmByOrgId } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery } from '../third-party/athena/query';
import { tableExists, getTableAllColumnNames } from '../third-party/athena/glue';
import { S3Config } from '../../utils/validate-aws-credentials';
import { IsoDateString } from '../../utils/iso-date';

// Self-contained copies of restore-retrieve/index.ts's private naming/region
// helpers (toGlueId, buildRetrieveOutputLocation) — kept local rather than
// imported so this service has zero dependency on that shared file and can
// evolve independently without risking a conflict in it.
const toGlueId = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_]/g, '_');

interface IAthenaLocation {
  region: string;
  outputLocation?: string;
}

const buildArchivalOutputLocation = async (config: IBackupConfig): Promise<IAthenaLocation> => {
  const destination = await getDestinationById(config.destinationId);
  if (!destination) return { region: AWS_REGION };

  const { bucketName, region } = getDecryptedDestinationConfig(destination) as S3Config;
  return {
    region: region || AWS_REGION,
    outputLocation: bucketName ? `s3://${bucketName}/salesforce/${config.crmId}/retrieve/` : undefined,
  };
};

const hudiTableFor = (config: IBackupConfig, objectApiName: string): { databaseName: string; hudiTable: string } => {
  const databaseName = toGlueId(config.backupConfigId);
  return { databaseName, hudiTable: `cfg_${databaseName}_${toGlueId(objectApiName)}_hudi` };
};

// ---------------------------------------------------------------------------
// Config resolution — shared by both the search and the detail endpoint, so
// neither re-implements the orgId -> crm -> archival configs lookup on its own.
// ---------------------------------------------------------------------------

// Depth-first search over a config's actual object tree (root objects +
// nested children[]) for a node named `targetName`. objectNames (the flat
// array stored alongside `objects`) only ever reflected top-level tree
// selections, not nested children, so a config archiving a child object
// (e.g. Contact under Account) would never match on that field — the tree
// itself is the accurate source, so this walks it directly instead.
const treeHasObject = (nodes: any[] | undefined, targetName: string): boolean => {
  for (const node of nodes ?? []) {
    if (node?.name === targetName) return true;
    if (treeHasObject(node?.children, targetName)) return true;
  }
  return false;
};

/**
 * Every ARCHIVAL config in this org that covers objName, plus the resolved
 * crm. Null when the org itself doesn't exist — a distinct case from "org
 * exists but has no archival config for this object" (empty configs array),
 * which callers handle themselves (404 vs "no policy" are different
 * responses).
 */
const resolveArchivalConfigsForObject = async (
  orgId: string,
  objName: string
): Promise<{ crm: ICrm; configs: IBackupConfig[] } | null> => {
  const crm = await getCrmByOrgId(orgId);
  if (!crm) return null;

  const result = await docClient.send(
    new QueryCommand({
      TableName: BACKUP_CONFIG_TABLE,
      IndexName: 'crmId-index',
      KeyConditionExpression: 'crmId = :crmId',
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: {
        ':crmId': crm.crmId,
        ':type': BACKUP_TYPE.archival,
      },
    })
  );
  const allConfigs = (result.Items as IBackupConfig[] | undefined) ?? [];
  const configs = allConfigs.filter((config) => treeHasObject(config.objects as any[], objName));
  return { crm, configs };
};

// ---------------------------------------------------------------------------
// Field / filter validation — every identifier the caller supplies (field
// names) is whitelisted against this shape before being interpolated into
// SQL; every value is quote-escaped. The Athena SDK has no parameterized
// query support for column identifiers, so this whitelist-and-escape
// discipline is the actual injection defense, not a convenience check.
// ---------------------------------------------------------------------------

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RECORD_ID_RE = /^[A-Za-z0-9]{15,18}$/;

const escapeSqlValue = (value: string): string => `'${value.replace(/'/g, "''")}'`;

// Simple plain-object filter shape instead of an array of {field,operator,value}
// triples: { "Status": "Active" } means Status = 'Active'; a key suffixed
// "_ne" means NOT_EQUALS — { "Email_ne": "x@y.com" } means Email <> 'x@y.com'.
// One key per field, ANDed together.
const NOT_EQUAL_SUFFIX = '_ne';

type IArchivalFilters = Record<string, string>;

type IValidateFiltersResult =
  | { ok: true; where: string; fields: string[] }
  | { ok: false; error: 'invalid_filters' | 'invalid_filter_field' };

/**
 * Validates and compiles the filters object into a SQL WHERE fragment
 * (conditions ANDed together). Never throws — a caller-supplied filter is
 * untrusted input, not a programmer error, so a bad field is a normal
 * validation failure the controller turns into a 400.
 */
const validateAndBuildFilterWhere = (filters: unknown): IValidateFiltersResult => {
  if (filters === undefined) return { ok: true, where: '', fields: [] };
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    return { ok: false, error: 'invalid_filters' };
  }

  const conditions: string[] = [];
  const fields: string[] = [];
  for (const [key, rawValue] of Object.entries(filters as Record<string, unknown>)) {
    // Numbers/booleans are accepted and compared as text (the column is CAST to
    // varchar below), so { "IsDeleted": false } works the same as "false".
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      return { ok: false, error: 'invalid_filters' };
    }
    const value = String(rawValue);

    const isNotEqual = key.endsWith(NOT_EQUAL_SUFFIX);
    const field = isNotEqual ? key.slice(0, -NOT_EQUAL_SUFFIX.length) : key;
    if (!FIELD_NAME_RE.test(field)) return { ok: false, error: 'invalid_filter_field' };
    fields.push(field);

    // CAST to varchar: the column's Athena type isn't guaranteed (a boolean/number
    // column compared to a quoted literal fails the whole query). "_ne" also keeps
    // NULL rows — SQL's `NULL <> 'x'` is NULL, which would silently drop them.
    const column = `CAST("${field}" AS varchar)`;
    conditions.push(
      isNotEqual
        ? `("${field}" IS NULL OR ${column} <> ${escapeSqlValue(value)})`
        : `${column} = ${escapeSqlValue(value)}`
    );
  }
  return { ok: true, where: conditions.join(' AND '), fields };
};

const validateFields = (fields: unknown): { ok: true; fields: string[] | null } | { ok: false } => {
  if (fields === undefined) return { ok: true, fields: null };
  if (!Array.isArray(fields) || !fields.length || !fields.every((f) => typeof f === 'string' && FIELD_NAME_RE.test(f))) {
    return { ok: false };
  }
  return { ok: true, fields: fields as string[] };
};

// Trims a row down to the requested fields — used identically for the search
// results and for the detail endpoint's main record + every related record,
// so "give me only Id/Name" behaves the same everywhere. null/undefined
// fields means "no selection requested", i.e. return the row as-is.
// Athena returns column names lowercased (Glue/Hive catalog), however they
// were quoted in the SQL — a row from `SELECT "Id"` comes back keyed "id".
// Callers know fields by their Salesforce API name ("Id", "CreatedDate"), so
// every lookup into an Athena row goes through this instead of record[name].
const getField = (record: Record<string, string>, name: string): string | undefined =>
  record[name] ?? record[name.toLowerCase()];

const applyFieldSelection = (
  record: Record<string, string>,
  fields: string[] | null
): Record<string, string> => {
  if (!fields) return record;
  const trimmed: Record<string, string> = {};
  for (const field of fields) trimmed[field] = getField(record, field) ?? '';
  return trimmed;
};

// ---------------------------------------------------------------------------
// API 1 — search/list, across every config covering the object
// ---------------------------------------------------------------------------

// Same three-way parse restore-retrieve/athena-fetch.ts uses (asInstant): the
// CreatedDate column is a native timestamp on some Glue tables, an ISO varchar
// (Salesforce's "+0000" spelling) or epoch millis on others, so comparing it
// straight against an ISO string is wrong or a type error depending on the table.
// Kept as a local copy for the same isolation reason as toGlueId above.
const CREATED_DATE_INSTANT =
  `COALESCE(TRY(CAST("CreatedDate" AS timestamp)), ` +
  `TRY(from_iso8601_timestamp(CAST("CreatedDate" AS varchar))), ` +
  `TRY(from_unixtime(CAST(CAST("CreatedDate" AS varchar) AS bigint) / 1000, 'UTC')))`;

// Athena has no SELECT * EXCEPT, so the column list is read from the catalog.
// Datetime columns are left out because the Glue type (varchar) disagrees with
// the Parquet type (timestamp) on some archival tables, which fails the whole query.
// The Glue type is the wrong one here, so information_schema can't say which
// columns are datetimes — they're recognised by name: CreatedDate,
// LastModifiedDate, SystemModstamp, Test_Time__c, Some_DateTime__c, ...
const DATETIME_COLUMN_RE = /(date|datetime|time|stamp)(__c)?$/i;
const isDatetimeColumn = (name: string): boolean => DATETIME_COLUMN_RE.test(name);

// Column lists come from the Glue catalog (instant, never queued) instead of an
// Athena information_schema query, and are cached per table — concurrent callers
// share one in-flight lookup. Schemas change rarely, so a short TTL is enough to
// pick up new columns; failures are never cached.
const COLUMNS_TTL_MS = 10 * 60_000;
const columnsCache = new Map<string, { columns: Promise<string[]>; cachedAt: number }>();

const getTableColumns = (hudiTable: string, databaseName: string, region: string): Promise<string[]> => {
  const cacheKey = `${region}:${databaseName}:${hudiTable}`;
  const cached = columnsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < COLUMNS_TTL_MS) return cached.columns;

  const columns = getTableAllColumnNames(databaseName, hudiTable, region);
  columnsCache.set(cacheKey, { columns, cachedAt: Date.now() });
  columns.catch(() => columnsCache.delete(cacheKey));
  return columns;
};

const quoteColumn = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * SELECT list for one table. Parquet is columnar and Athena bills per byte
 * scanned, so when the caller asked for specific `fields` only those columns
 * (plus `alwaysInclude`, which the handler needs internally, e.g. a parent FK)
 * are selected — matched case-insensitively against the table's real columns;
 * ones the table doesn't have are skipped (applyFieldSelection fills them ''),
 * and datetime columns stay excluded (see DATETIME_COLUMN_RE). No `fields`
 * means every non-datetime column.
 */
const buildSelectClause = async (
  hudiTable: string,
  databaseName: string,
  region: string,
  fields: string[] | null = null,
  alwaysInclude: string[] = []
): Promise<string> => {
  const columns = (await getTableColumns(hudiTable, databaseName, region)).filter((name) => !isDatetimeColumn(name));
  let selected = columns;
  if (fields) {
    const wanted = new Set([...fields, ...alwaysInclude].map((f) => f.toLowerCase()));
    selected = columns.filter((name) => wanted.has(name.toLowerCase()));
  }
  return selected.length ? selected.map(quoteColumn).join(', ') : '"Id"';
};

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

export interface IArchivalSearchParams {
  objectApiName: string;
  fields?: string[];
  startDate?: IsoDateString;
  endDate?: IsoDateString;
  filters?: IArchivalFilters;
  limit?: number;
  // 1-based. Page 1 (or omitted) is the first page.
  page?: number;
}

export type ArchivalSearchError =
  | 'invalid_filters'
  | 'invalid_filter_field'
  | 'unknown_filter_field'
  | 'invalid_fields'
  | 'invalid_limit'
  | 'invalid_page';

export interface IArchivalSearchResult {
  records: Record<string, string>[];
  hasMore: boolean;
  page: number;
}

/**
 * Queries every config's Hudi table for objectApiName, merges the rows, and
 * returns one page. Each config is queried with the same LIMIT+OFFSET (one
 * per config, not a single global offset split across them) — exact for the
 * common case of one archival config per object; when more than one config
 * covers the same object, a page can occasionally include more or fewer rows
 * than `limit` right at a page boundary. Acceptable for a preview/search
 * feature; the Restore flow's own paginated reconstruction (retrieveRecords
 * in restore-retrieve/index.ts) is the place exact cross-source pagination
 * already lives, and this deliberately doesn't reimplement it.
 */
const searchArchivalRecords = async (
  configs: IBackupConfig[],
  params: IArchivalSearchParams
): Promise<{ ok: true; result: IArchivalSearchResult } | { ok: false; error: ArchivalSearchError }> => {
  const fieldsCheck = validateFields(params.fields);
  if (!fieldsCheck.ok) return { ok: false, error: 'invalid_fields' };
  
  const filterCheck = validateAndBuildFilterWhere(params.filters);

  if (!filterCheck.ok) return { ok: false, error: filterCheck.error };

  const rawLimit = params.limit;
  if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1)) {
    return { ok: false, error: 'invalid_limit' };
  }
  const limit = Math.min(rawLimit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  const rawPage = params.page;
  if (rawPage !== undefined && (typeof rawPage !== 'number' || !Number.isInteger(rawPage) || rawPage < 1)) {
    return { ok: false, error: 'invalid_page' };
  }
  const page = rawPage ?? 1;
  const offset = (page - 1) * limit;

  // CreatedDate is always fetched, even when the caller's `fields` doesn't
  // ask for it — the merge-across-configs sort below depends on it being
  // present on every row. applyFieldSelection trims it back out afterwards
  // if the caller didn't actually request it.
console.log(configs,'selectClause')
  const perConfigResults = await Promise.all(
    configs.map(async (config) => {
      const { databaseName, hudiTable } = hudiTableFor(config, params.objectApiName);
      console.log(databaseName,'uuu hudi table ', hudiTable)
      const { region, outputLocation } = await buildArchivalOutputLocation(config);
      if (!(await tableExists(databaseName, hudiTable, region))) return { rows: [], missingFilterField: false };

      // A filter on a column this table doesn't have would fail the whole Athena
      // query (and cost a round trip) — no row here can match it, so skip the query.
      if (filterCheck.fields.length) {
        const known = new Set((await getTableColumns(hudiTable, databaseName, region)).map((c) => c.toLowerCase()));
        if (filterCheck.fields.some((f) => !known.has(f.toLowerCase()))) return { rows: [], missingFilterField: true };
      }

      const conditions: string[] = [];
      if (params.startDate) conditions.push(`${CREATED_DATE_INSTANT} >= from_iso8601_timestamp('${params.startDate}')`);
      if (params.endDate) conditions.push(`${CREATED_DATE_INSTANT} <= from_iso8601_timestamp('${params.endDate}')`);
      if (filterCheck.where) conditions.push(filterCheck.where);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      
      // TEMP-GLUE-WORKAROUND: only Id and Name are selected (no SELECT *, no
      // datetime columns) while the Glue column types are being fixed.
      // Fetch one extra row past `limit` so hasMore can be determined without
      // a second COUNT query.
      const selectClause = await buildSelectClause(hudiTable, databaseName, region, fieldsCheck.fields);
      const sql = `SELECT * FROM "${hudiTable}" ${where} ORDER BY "Id" OFFSET ${offset} LIMIT ${limit + 1}`;
      // const sql = `SELECT ${selectClause} FROM "${hudiTable}" ${where} ORDER BY "Id" OFFSET ${offset} LIMIT ${limit + 1}`;
      console.log(sql,'sql')
      const result = await runAthenaQuery(sql, databaseName, region, outputLocation, limit + 1);
      return { rows: result.rows, missingFilterField: false };
    })
  );

  // Every archived table lacked a filtered column -> the field name is wrong
  // (not merely "no matches"), so say so instead of returning an empty page.
  if (perConfigResults.length && perConfigResults.every((r) => r.missingFilterField)) {
    return { ok: false, error: 'unknown_filter_field' };
  }

  // TEMP-GLUE-WORKAROUND: was sorted by CreatedDate desc. Revert after Glue table fix.
  const merged = perConfigResults.flatMap((r) => r.rows);

  const hasMore = merged.length > limit;
  const records = merged.slice(0, limit).map((row) => applyFieldSelection(row, fieldsCheck.fields));

  return {
    ok: true,
    result: { records, hasMore, page },
  };
};

// ---------------------------------------------------------------------------
// API 2 — record detail, by Id
// ---------------------------------------------------------------------------

/**
 * One record's own fields, by Id, from an archival config's object Hudi
 * table. Returns null when the id is malformed, the table doesn't exist yet
 * (object never compressed under this config), or no row matches — the
 * caller decides what "not found" means, this never throws for those cases.
 */
const getArchivedRecordById = async (
  config: IBackupConfig,
  objectApiName: string,
  recordId: string,
  fields: string[] | null = null,
  alwaysInclude: string[] = []
): Promise<Record<string, string> | null> => {
  if (!RECORD_ID_RE.test(recordId)) return null;

  const { databaseName, hudiTable } = hudiTableFor(config, objectApiName);
  const { region, outputLocation } = await buildArchivalOutputLocation(config);

  if (!(await tableExists(databaseName, hudiTable, region))) return null;

  const selectClause = await buildSelectClause(hudiTable, databaseName, region, fields, alwaysInclude);
  const sql = `SELECT ${selectClause} FROM "${hudiTable}" WHERE "Id" = '${recordId}' LIMIT 1`;
  const result = await runAthenaQuery(sql, databaseName, region, outputLocation, 1);
  return result.rows[0] ?? null;
};

const RELATED_RECORDS_LIMIT = 50;
const getArchivedRelatedRecords = async (
  config: IBackupConfig,
  objectApiName: string,
  fkField: string,
  fkValue: string,
  fields: string[] | null = null
): Promise<Record<string, string>[]> => {
  if (!FIELD_NAME_RE.test(fkField) || !RECORD_ID_RE.test(fkValue)) return [];

  const { databaseName, hudiTable } = hudiTableFor(config, objectApiName);
  const { region, outputLocation } = await buildArchivalOutputLocation(config);

  if (!(await tableExists(databaseName, hudiTable, region))) return [];

  // A child table without the FK column would fail the whole Athena query — no row can match, so skip it.
  const known = new Set((await getTableColumns(hudiTable, databaseName, region)).map((c) => c.toLowerCase()));
  if (!known.has(fkField.toLowerCase())) return [];

  const selectClause = await buildSelectClause(hudiTable, databaseName, region, fields);
  const sql = `SELECT ${selectClause} FROM "${hudiTable}" WHERE "${fkField}" = '${fkValue}' LIMIT ${RELATED_RECORDS_LIMIT}`;
  const result = await runAthenaQuery(sql, databaseName, region, outputLocation, RELATED_RECORDS_LIMIT);
  return result.rows;
};

export {
  resolveArchivalConfigsForObject,
  searchArchivalRecords,
  applyFieldSelection,
  getField,
  validateFields,
  getArchivedRecordById,
  getArchivedRelatedRecords,
  type IArchivalFilters,
};
