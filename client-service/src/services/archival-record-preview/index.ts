import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { AWS_REGION, BACKUP_CONFIG_TABLE, BACKUP_TYPE } from '../../constant';
import { IBackupConfig, ICrm } from '../../models';
import { getCrmByOrgId, getCrmById } from '../crm';
import { readSchemaFile } from '../schema';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery } from '../third-party/athena/query';
import { tableExists, getTableAllColumnNames } from '../third-party/athena/glue';
import { S3Config } from '../../utils/validate-aws-credentials';
import { IsoDateString, toIsoDateString } from '../../utils/iso-date';

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

// A Salesforce org Id has two spellings — 15 chars (case-sensitive) and 18
// chars (the same 15 plus a 3-char case checksum) — and callers send either,
// while the crm row stores one. The 18-char suffix is derived from the 15: each
// 5-char chunk becomes a 5-bit number (bit i set when char i is uppercase),
// mapped onto A-Z0-5. The exact spelling is tried first.
const CHECKSUM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

const toEighteenCharId = (fifteen: string): string => {
  let suffix = '';
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const char = fifteen[chunk * 5 + i];
      if (char >= 'A' && char <= 'Z') bits |= 1 << i;
    }
    suffix += CHECKSUM_ALPHABET[bits];
  }
  return fifteen + suffix;
};

const salesforceIdSpellings = (orgId: string): string[] => {
  const id = orgId.trim();
  if (/^[A-Za-z0-9]{15}$/.test(id)) return [...new Set([orgId, id, toEighteenCharId(id)])];
  if (/^[A-Za-z0-9]{18}$/.test(id)) return [...new Set([orgId, id, id.slice(0, 15)])];
  return [orgId];
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
  let crm: ICrm | null = null;
  for (const candidate of salesforceIdSpellings(orgId)) {
    crm = await getCrmByOrgId(candidate);
    if (crm) break;
  }
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
// One key per field, ANDed together. The reserved key "OR" holds a nested
// object of the same shape whose conditions are ORed with each other; that
// group is then ANDed with the rest — { "Status": "Active", "OR": { "Id": "x",
// "Name": "y" } } means Status = 'Active' AND (Id = 'x' OR Name = 'y').
const NOT_EQUAL_SUFFIX = '_ne';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OR_KEY = 'OR';

type IArchivalFilterValue = string | number | boolean;
type IArchivalFilters = Record<string, IArchivalFilterValue | Record<string, IArchivalFilterValue>>;

interface IFilterCondition {
  field: string;
  sql: string;
  // "_ne" condition: on a column the table lacks (always NULL) it is true for every row.
  negated?: boolean;
}

type IFilterError = 'invalid_filters' | 'invalid_filter_field';

type IValidateFiltersResult =
  | { ok: true; and: IFilterCondition[]; or: IFilterCondition[] }
  | { ok: false; error: IFilterError };

// Compiles one flat { field: value } object into conditions.
const buildConditions = (
  filters: Record<string, unknown>
): { ok: true; conditions: IFilterCondition[] } | { ok: false; error: IFilterError } => {
  const conditions: IFilterCondition[] = [];
  for (const [key, rawValue] of Object.entries(filters)) {
    // Numbers/booleans are accepted and compared as text (the column is CAST to
    // varchar below), so { "IsDeleted": false } works the same as "false".
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      return { ok: false, error: 'invalid_filters' };
    }
    const value = String(rawValue);

    const isNotEqual = key.toLowerCase().endsWith(NOT_EQUAL_SUFFIX);
    const field = isNotEqual ? key.slice(0, -NOT_EQUAL_SUFFIX.length) : key;
    if (!FIELD_NAME_RE.test(field)) return { ok: false, error: 'invalid_filter_field' };

    // CAST to varchar: the column's Athena type isn't guaranteed (a boolean/number
    // column compared to a quoted literal fails the whole query). "_ne" also keeps
    // NULL rows — SQL's `NULL <> 'x'` is NULL, which would silently drop them.
    const column = `CAST("${field}" AS varchar)`;
    const exact = `${column} = ${escapeSqlValue(value)}`;

    // A date-only value ("2026-07-03") on a datetime column can never equal a
    // stored "2026-07-03 11:52:47.000" as text, so it means that whole (UTC)
    // day. The exact text match stays as well, so a plain text field holding
    // "2026-07-03" is still found.
    const dayStart = DATE_ONLY_RE.test(value) ? toIsoDateString(value, 'start') : null;
    const dayEnd = dayStart ? toIsoDateString(value, 'end') : null;
    const equals =
      dayStart && dayEnd
        ? `(${exact} OR (${datetimeInstant(field)} >= from_iso8601_timestamp('${dayStart}') ` +
          `AND ${datetimeInstant(field)} <= from_iso8601_timestamp('${dayEnd}')))`
        : exact;

    conditions.push({
      field,
      sql: isNotEqual
        ? dayStart
          ? `("${field}" IS NULL OR NOT COALESCE(${equals}, false))`
          : `("${field}" IS NULL OR ${column} <> ${escapeSqlValue(value)})`
        : equals,
      negated: isNotEqual,
    });
  }
  return { ok: true, conditions };
};

/**
 * Validates the filters object and compiles it into AND conditions plus an
 * optional OR group. Never throws — a caller-supplied filter is untrusted
 * input, not a programmer error, so a bad field is a normal validation
 * failure the controller turns into a 400.
 */
const validateAndBuildFilters = (filters: unknown): IValidateFiltersResult => {
  if (filters === undefined) return { ok: true, and: [], or: [] };
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    return { ok: false, error: 'invalid_filters' };
  }

  // Keys are matched case-insensitively: "OR"/"or", "CreatedDate"/"CREATEDDATE"/"createddate_NE".
  const andFilters: Record<string, unknown> = {};
  let orGroup: unknown;
  let orKeys = 0;
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (key.toUpperCase() === OR_KEY) {
      orGroup = value;
      orKeys += 1;
    } else andFilters[key] = value;
  }
  if (orKeys > 1) return { ok: false, error: 'invalid_filters' };

  const andResult = buildConditions(andFilters);
  if (!andResult.ok) return andResult;
  if (orGroup === undefined) return { ok: true, and: andResult.conditions, or: [] };

  if (typeof orGroup !== 'object' || orGroup === null || Array.isArray(orGroup)) {
    return { ok: false, error: 'invalid_filters' };
  }
  const orResult = buildConditions(orGroup as Record<string, unknown>);
  if (!orResult.ok) return orResult;
  // An empty OR would silently mean "no filter" — almost certainly a caller mistake.
  if (!orResult.conditions.length) return { ok: false, error: 'invalid_filters' };

  return { ok: true, and: andResult.conditions, or: orResult.conditions };
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
const datetimeInstant = (field: string): string =>
  `COALESCE(TRY(CAST("${field}" AS timestamp)), ` +
  `TRY(from_iso8601_timestamp(CAST("${field}" AS varchar))), ` +
  `TRY(from_unixtime(CAST(CAST("${field}" AS varchar) AS bigint) / 1000, 'UTC')))`;

// The Hudi tables carry bookkeeping columns (_hoodie_commit_time, ...) that a
// SELECT * would scan and return; they are never part of the object's data.
const isHudiMetaColumn = (name: string): boolean => name.startsWith('_hoodie_');

// The object's own field list, from the schema the backup wrote to the client's
// S3 (schema/main/<object>/fields/fields.json). It is the authoritative list of
// the object's fields, so the SELECT names exactly those instead of `*`. Cached
// per config+object — a schema changes rarely — and failures are never cached.
const SCHEMA_FIELDS_TTL_MS = 10 * 60_000;
const SCHEMA_FIELDS_MAX_ENTRIES = 500;
const schemaFieldsCache = new Map<string, { fields: Promise<string[] | null>; cachedAt: number }>();

// The stored file is either the schema history ([{ sourceType, context: fields[] }])
// or, in the main layout, the fields array itself — accept both.
const extractFieldNames = (schema: unknown): string[] | null => {
  if (!Array.isArray(schema) || !schema.length) return null;
  const isHistory = schema.every((entry) => Array.isArray(entry?.context));
  const fields: any[] = isHistory
    ? (schema.find((entry) => entry.sourceType === 'main') ?? schema[schema.length - 1]).context
    : schema;
  const names = fields.map((f) => f?.name).filter((name): name is string => typeof name === 'string' && !!name);
  return names.length ? names : null;
};

const loadSchemaFieldNames = async (config: IBackupConfig, objectApiName: string): Promise<string[] | null> => {
  const [crm, destination] = await Promise.all([getCrmById(config.crmId), getDestinationById(config.destinationId)]);
  if (!crm || !destination) return null;

  const schema = await readSchemaFile(getDecryptedDestinationConfig(destination) as S3Config, {
    crmId: crm.crmId,
    crmName: crm.crmName,
    backupConfigId: config.backupConfigId,
    objectName: objectApiName,
    type: 'archival',
    kind: 'fields',
  });
  return extractFieldNames(schema);
};

const getSchemaFieldNames = (config: IBackupConfig, objectApiName: string): Promise<string[] | null> => {
  const cacheKey = `${config.backupConfigId}:${objectApiName}`;
  const cached = schemaFieldsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SCHEMA_FIELDS_TTL_MS) return cached.fields;

  if (schemaFieldsCache.size >= SCHEMA_FIELDS_MAX_ENTRIES) {
    schemaFieldsCache.delete(schemaFieldsCache.keys().next().value as string);
  }

  const fields = loadSchemaFieldNames(config, objectApiName);
  schemaFieldsCache.set(cacheKey, { fields, cachedAt: Date.now() });
  // A missing schema (not written yet) or a failed read is retried by the next call.
  fields.then((names) => names || schemaFieldsCache.delete(cacheKey), () => schemaFieldsCache.delete(cacheKey));
  return fields;
};

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
 * SELECT list for one object's table — never `*`. Parquet is columnar and
 * Athena bills per byte scanned, so only real object fields are read: the S3
 * schema's field list, intersected with the table's actual columns (a field
 * added since the last compression, or dropped, must not break the query; the
 * table's names are used, as Glue spells them). Hudi bookkeeping columns are
 * left out. When the schema can't be read the table's own columns stand in.
 * When the caller asked for specific `fields`, only those (plus `alwaysInclude`,
 * which the handler needs internally, e.g. a parent FK) are selected, matched
 * case-insensitively; ones the table doesn't have are skipped
 * (applyFieldSelection fills them ''). Datetime columns are included like any
 * other — they need a Glue type that matches the Parquet one.
 */
const buildSelectClause = async (
  config: IBackupConfig,
  objectApiName: string,
  region: string,
  fields: string[] | null = null,
  alwaysInclude: string[] = []
): Promise<string> => {
  const { databaseName, hudiTable } = hudiTableFor(config, objectApiName);
  const [tableColumns, schemaFields] = await Promise.all([
    getTableColumns(hudiTable, databaseName, region),
    getSchemaFieldNames(config, objectApiName).catch(() => null),
  ]);

  let columns = tableColumns.filter((name) => !isHudiMetaColumn(name));
  if (schemaFields) {
    // "Id" stays even if the schema omits it: paging orders by it.
    const inSchema = new Set([...schemaFields, 'Id'].map((f) => f.toLowerCase()));
    const fromSchema = columns.filter((name) => inSchema.has(name.toLowerCase()));
    if (fromSchema.length) columns = fromSchema;
  }

  let selected = columns;
  if (fields) {
    const wanted = new Set([...fields, ...alwaysInclude].map((f) => f.toLowerCase()));
    selected = columns.filter((name) => wanted.has(name.toLowerCase()));
  }
  return selected.length ? selected.map(quoteColumn).join(', ') : '"Id"';
};

// Range filter on any datetime column (CreatedDate, LastModifiedDate, ...):
// { "CreatedDate": { "from": "2026-07-03T11:00:00Z", "to": "2026-07-03T12:00:00Z" } }.
// Either bound may be omitted; both are inclusive. A bound is an ISO date or
// timestamp (UTC when no zone is given); a date-only "to" means the end of that
// day. The stored "2026-07-03 11:52:47.000" spelling is accepted too.
interface IArchivalDateRange {
  from?: string;
  to?: string;
}
type IArchivalDateFilters = Record<string, IArchivalDateRange>;

type ICriteriaError = IFilterError | 'invalid_date_filters';

// Everything a caller can filter rows by, validated and compiled once so the
// search and the detail endpoint apply identical rules.
interface IArchivalCriteria {
  and: IFilterCondition[];
  or: IFilterCondition[];
  dates: IFilterCondition[];
}

const DATE_WITH_SPACE_RE = /^(\d{4}-\d{2}-\d{2}) (?=\d)/;

const buildDateConditions = (
  dateFilters: unknown
): { ok: true; conditions: IFilterCondition[] } | { ok: false; error: 'invalid_date_filters' } => {
  if (dateFilters === undefined) return { ok: true, conditions: [] };
  if (typeof dateFilters !== 'object' || dateFilters === null || Array.isArray(dateFilters)) {
    return { ok: false, error: 'invalid_date_filters' };
  }

  const conditions: IFilterCondition[] = [];
  for (const [field, range] of Object.entries(dateFilters as Record<string, unknown>)) {
    if (!FIELD_NAME_RE.test(field) || typeof range !== 'object' || range === null || Array.isArray(range)) {
      return { ok: false, error: 'invalid_date_filters' };
    }
    const { from, to } = range as IArchivalDateRange;
    if (from === undefined && to === undefined) return { ok: false, error: 'invalid_date_filters' };

    const instant = datetimeInstant(field);
    const bounds: [unknown, 'start' | 'end', '>=' | '<='][] = [
      [from, 'start', '>='],
      [to, 'end', '<='],
    ];
    let start: IsoDateString | null = null;
    let end: IsoDateString | null = null;
    for (const [raw, bound, operator] of bounds) {
      if (raw === undefined) continue;
      const parsed = typeof raw === 'string' ? toIsoDateString(raw.replace(DATE_WITH_SPACE_RE, '$1T'), bound) : null;
      if (!parsed) return { ok: false, error: 'invalid_date_filters' };
      if (bound === 'start') start = parsed;
      else end = parsed;
      conditions.push({ field, sql: `${instant} ${operator} from_iso8601_timestamp('${parsed}')` });
    }
    if (start && end && start > end) return { ok: false, error: 'invalid_date_filters' };
  }
  return { ok: true, conditions };
};

const compileArchivalCriteria = (
  filters: unknown,
  dateFilters: unknown
): { ok: true; criteria: IArchivalCriteria } | { ok: false; error: ICriteriaError } => {
  const filterCheck = validateAndBuildFilters(filters);
  if (!filterCheck.ok) return filterCheck;
  const dateCheck = buildDateConditions(dateFilters);
  if (!dateCheck.ok) return dateCheck;
  return { ok: true, criteria: { and: filterCheck.and, or: filterCheck.or, dates: dateCheck.conditions } };
};

// WHERE conditions for one table. `missing` means the table lacks a filtered
// column, so no row in it can match and the Athena query is skipped: an AND
// (or date) condition on a missing column would fail the whole query and can
// never match; an OR branch on one can never match either, so it is just
// dropped — only when every branch is dropped is the table skipped.
const buildTableConditions = async (
  criteria: IArchivalCriteria,
  hudiTable: string,
  databaseName: string,
  region: string
): Promise<{ conditions: string[]; missing: false } | { missing: true }> => {
  const required = [...criteria.and, ...criteria.dates];
  if (!required.length && !criteria.or.length) return { conditions: [], missing: false };

  const known = new Set((await getTableColumns(hudiTable, databaseName, region)).map((c) => c.toLowerCase()));
  const hasColumn = (c: IFilterCondition) => known.has(c.field.toLowerCase());

  if (!required.every(hasColumn)) return { missing: true };
  const conditions = required.map((c) => c.sql);

  // A missing column is NULL on every row: an equality branch on it never matches
  // (dropped), but a "_ne" branch is true for every row, making the whole OR true.
  const orMatchesEverything = criteria.or.some((c) => c.negated && !hasColumn(c));
  const orConditions = criteria.or.filter(hasColumn);
  if (criteria.or.length && !orMatchesEverything) {
    if (!orConditions.length) return { missing: true };
    conditions.push(`(${orConditions.map((c) => c.sql).join(' OR ')})`);
  }
  return { conditions, missing: false };
};

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

export interface IArchivalSearchParams {
  objectApiName: string;
  fields?: string[];
  startDate?: IsoDateString;
  endDate?: IsoDateString;
  filters?: IArchivalFilters;
  dateFilters?: IArchivalDateFilters;
  limit?: number;
  // 1-based. Page 1 (or omitted) is the first page.
  page?: number;
}

export type ArchivalSearchError =
  | 'invalid_filters'
  | 'invalid_filter_field'
  | 'invalid_date_filters'
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
  
  const criteriaCheck = compileArchivalCriteria(params.filters, params.dateFilters);
  if (!criteriaCheck.ok) return { ok: false, error: criteriaCheck.error };
  const { criteria } = criteriaCheck;

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

      const [table, selectClause] = await Promise.all([
        buildTableConditions(criteria, hudiTable, databaseName, region),
        buildSelectClause(config, params.objectApiName, region, fieldsCheck.fields),
      ]);
      if (table.missing) return { rows: [], missingFilterField: true };

      const conditions: string[] = [];
      const createdInstant = datetimeInstant('CreatedDate');
      if (params.startDate) conditions.push(`${createdInstant} >= from_iso8601_timestamp('${params.startDate}')`);
      if (params.endDate) conditions.push(`${createdInstant} <= from_iso8601_timestamp('${params.endDate}')`);
      conditions.push(...table.conditions);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // Fetch one extra row past `limit` so hasMore can be determined without
      // a second COUNT query.
      const sql = `SELECT ${selectClause} FROM "${hudiTable}" ${where} ORDER BY "Id" OFFSET ${offset} LIMIT ${limit + 1}`;
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
  alwaysInclude: string[] = [],
  criteria: IArchivalCriteria = { and: [], or: [], dates: [] }
): Promise<Record<string, string> | null> => {
  if (!RECORD_ID_RE.test(recordId)) return null;

  const { databaseName, hudiTable } = hudiTableFor(config, objectApiName);
  const { region, outputLocation } = await buildArchivalOutputLocation(config);

  if (!(await tableExists(databaseName, hudiTable, region))) return null;

  // The record must also satisfy the caller's filters; a table lacking a filtered column can't match.
  const table = await buildTableConditions(criteria, hudiTable, databaseName, region);
  if (table.missing) return null;

  const where = [`"Id" = '${recordId}'`, ...table.conditions].join(' AND ');
  const selectClause = await buildSelectClause(config, objectApiName, region, fields, alwaysInclude);
  const sql = `SELECT ${selectClause} FROM "${hudiTable}" WHERE ${where} LIMIT 1`;
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

  const selectClause = await buildSelectClause(config, objectApiName, region, fields);
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
  compileArchivalCriteria,
  type IArchivalCriteria,
  type IArchivalFilters,
  type IArchivalDateFilters,
};
