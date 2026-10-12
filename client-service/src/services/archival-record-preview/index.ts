import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config';
import { AWS_REGION, BACKUP_CONFIG_TABLE, BACKUP_TYPE } from '../../constant';
import { IBackupConfig, ICrm, IS3Config } from '../../models';
import { getCrmByOrgId, getCrmById } from '../crm';
import { readSchemaFile } from '../schema';
import { logger } from '../../middlewares';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { runAthenaQuery } from '../third-party/athena/query';
import { tableExists, getTableAllColumnNames } from '../third-party/athena/glue';
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

  const { bucketName, region } = getDecryptedDestinationConfig(destination) as IS3Config;
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
// Names are matched case-insensitively ("product2" finds "Product2"), and the
// tree's own spelling is returned so callers use the object's real API name.
const findObjectNameInTree = (nodes: any[] | undefined, targetName: string): string | null => {
  const target = targetName.toLowerCase();
  for (const node of nodes ?? []) {
    if (typeof node?.name === 'string' && node.name.toLowerCase() === target) return node.name;
    const nested = findObjectNameInTree(node?.children, targetName);
    if (nested) return nested;
  }
  return null;
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
): Promise<{ crm: ICrm; configs: IBackupConfig[]; objName: string } | null> => {
  let crm: ICrm | null = null;
  for (const candidate of salesforceIdSpellings(orgId)) {
    crm = await getCrmByOrgId(candidate);
    if (crm) break;
  }
  if (!crm) {
    logger.info(`[archival-preview] resolve | no crm for orgId:${orgId} tried:${salesforceIdSpellings(orgId).join(',')}`);
    return null;
  }

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
  const configs = allConfigs.filter((config) => findObjectNameInTree(config.objects as any[], objName));
  const canonicalObjName = findObjectNameInTree(configs[0]?.objects as any[], objName) ?? objName;
  // Says which lookup step came up empty when a caller reports "not found":
  // crm (org id spelling), archival configs at all, or configs covering objName.
  logger.info(
    `[archival-preview] resolve | orgId:${orgId} crmId:${crm.crmId} crmOrganizationId:${crm.organizationId} ` +
    `archivalConfigs:${allConfigs.length} coveringObject(${objName}):${configs.length}`
  );
  return { crm, configs, objName: canonicalObjName };
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

// Filter shape (plain JSON, SOQL-like). Every form below is a "group": a
// plain object whose conditions are ANDed together.
//   { "Status": "Active" }                       Status = 'Active'
//   { "Email_ne": "x@y.com" }                    Email <> 'x@y.com'   ("_ne" suffix)
//   { "Stage": ["Won", "Lost"] }                 Stage IN ('Won', 'Lost')
//   { "Stage_ne": ["Won", "Lost"] }              Stage NOT IN ('Won', 'Lost')
//   { "CreatedDate": { "from": "2026-01-01", "to": "2026-03-31" } }   date range (either bound optional)
// Text matching is case-insensitive. "AND" / "OR" keys combine nested groups:
//   { "Status": "Active", "OR": [ { "Type": "A" }, { "Type": "B", "Rating": "Hot" } ] }
//     means Status = 'Active' AND (Type = 'A' OR (Type = 'B' AND Rating = 'Hot'))
//   { "OR": [ { "AND": [ {...}, {...} ] }, {...} ] } nests up to MAX_FILTER_DEPTH levels.
// Legacy form, kept as-is: "OR" holding a plain object (not an array) ORs that
// object's conditions together with the group's own top-level ones —
// { "OwnerId": "o", "OR": { "Id": "x", "Name": "y" } } means
// OwnerId = 'o' OR Id = 'x' OR Name = 'y'.
const NOT_EQUAL_SUFFIX = '_ne';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILTER_DEPTH = 5;
const MAX_FILTER_CONDITIONS = 50;
const MAX_IN_VALUES = 200;

type IArchivalFilterScalar = string | number | boolean;
type IArchivalFilterValue = IArchivalFilterScalar | IArchivalFilterScalar[] | IArchivalDateRange;
interface IArchivalFilters {
  [key: string]: IArchivalFilterValue | IArchivalFilters | IArchivalFilters[];
}

interface IFilterCondition {
  field: string;
  sql: string;
  // "_ne" condition: on a column the table lacks (always NULL) it is true for every row.
  negated?: boolean;
}

// The compiled filter: leaves are SQL conditions, branches are AND / OR groups.
type IFilterNode =
  | { kind: 'condition'; condition: IFilterCondition }
  | { kind: 'and' | 'or'; children: IFilterNode[] };

type IFilterError = 'invalid_filters' | 'invalid_filter_field' | 'invalid_date_filters';

type IValidateFiltersResult = { ok: true; where: IFilterNode | null } | { ok: false; error: IFilterError };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFilterScalar = (value: unknown): value is IArchivalFilterScalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const logicalKeyOf = (key: string): 'AND' | 'OR' | null => {
  const upper = key.toUpperCase();
  return upper === 'AND' || upper === 'OR' ? upper : null;
};

// Compiles one flat { field: value } object into conditions.
const buildConditions = (
  filters: Record<string, unknown>
): { ok: true; conditions: IFilterCondition[] } | { ok: false; error: IFilterError } => {
  const conditions: IFilterCondition[] = [];
  for (const [key, rawValue] of Object.entries(filters)) {
    // Every filter is optional: a null value or an empty IN list means "not provided".
    if (rawValue === undefined || rawValue === null || (Array.isArray(rawValue) && !rawValue.length)) continue;

    const isNotEqual = key.toLowerCase().endsWith(NOT_EQUAL_SUFFIX);
    const field = isNotEqual ? key.slice(0, -NOT_EQUAL_SUFFIX.length) : key;
    if (!FIELD_NAME_RE.test(field)) return { ok: false, error: 'invalid_filter_field' };

    // CAST to varchar: the column's Athena type isn't guaranteed (a boolean/number
    // column compared to a quoted literal fails the whole query). "_ne" also keeps
    // NULL rows — SQL's `NULL <> 'x'` is NULL, which would silently drop them.
    // Text matching is case-insensitive: both sides are lower-cased, so
    // "sunny kumar" finds "Sunny Kumar".
    const column = `LOWER(CAST("${field}" AS varchar))`;

    // { "from": ..., "to": ... } — a date range on a datetime column.
    if (isPlainObject(rawValue)) {
      const rangeSql = isNotEqual ? null : buildRangeSql(field, rawValue);
      if (!rangeSql) return { ok: false, error: 'invalid_date_filters' };
      conditions.push({ field, sql: rangeSql });
      continue;
    }

    // [a, b, c] — IN (or NOT IN with "_ne").
    if (Array.isArray(rawValue)) {
      if (!rawValue.length || rawValue.length > MAX_IN_VALUES || !rawValue.every(isFilterScalar)) {
        return { ok: false, error: 'invalid_filters' };
      }
      // Duplicates (any casing) add nothing to an IN list, only SQL length.
      const unique = [...new Set(rawValue.map((v) => String(v).toLowerCase()))];
      const list = unique.map((v) => `LOWER(${escapeSqlValue(v)})`).join(', ');
      conditions.push({
        field,
        sql: isNotEqual ? `("${field}" IS NULL OR ${column} NOT IN (${list}))` : `${column} IN (${list})`,
        negated: isNotEqual,
      });
      continue;
    }

    // Numbers/booleans are accepted and compared as text (the column is CAST to
    // varchar), so { "IsDeleted": false } works the same as "false".
    if (!isFilterScalar(rawValue)) return { ok: false, error: 'invalid_filters' };
    const value = String(rawValue);
    const lowered = `LOWER(${escapeSqlValue(value)})`;
    const exact = `${column} = ${lowered}`;

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
          : `("${field}" IS NULL OR ${column} <> ${lowered})`
        : equals,
      negated: isNotEqual,
    });
  }
  return { ok: true, conditions };
};

const conditionNodes = (conditions: IFilterCondition[]): IFilterNode[] =>
  conditions.map((condition) => ({ kind: 'condition', condition }));

// The value of an "AND" / "OR" key: a list of groups (a single object is one group).
const buildGroupList = (kind: 'and' | 'or', value: unknown, depth: number): IValidateFiltersResult => {
  const groups = Array.isArray(value) ? value : [value];

  // Empty / null groups are "not provided" and skipped.
  const children: IFilterNode[] = [];
  for (const group of groups) {
    const built = buildFilterGroup(group, depth + 1);
    if (!built.ok) return built;
    if (built.where) children.push(built.where);
  }
  return { ok: true, where: children.length ? { kind, children } : null };
};

const buildFilterGroup = (group: unknown, depth: number): IValidateFiltersResult => {
  if (group === undefined || group === null) return { ok: true, where: null };
  if (!isPlainObject(group) || depth > MAX_FILTER_DEPTH) return { ok: false, error: 'invalid_filters' };

  // Keys are matched case-insensitively: "OR"/"or", "CreatedDate"/"CREATEDDATE"/"createddate_NE".
  const leaves: Record<string, unknown> = {};
  const logical: { AND?: unknown; OR?: unknown } = {};
  for (const [key, value] of Object.entries(group)) {
    const logicalKey = logicalKeyOf(key);
    if (!logicalKey) leaves[key] = value;
    else if (logicalKey in logical) return { ok: false, error: 'invalid_filters' };
    else logical[logicalKey] = value;
  }

  const leafResult = buildConditions(leaves);
  if (!leafResult.ok) return leafResult;
  let nodes = conditionNodes(leafResult.conditions);

  if (isPlainObject(logical.OR)) {
    // Legacy: the OR object's conditions and the group's own are alternatives.
    if (Object.keys(logical.OR).some(logicalKeyOf)) return { ok: false, error: 'invalid_filters' };
    const orResult = buildConditions(logical.OR);
    if (!orResult.ok) return orResult;
    if (orResult.conditions.length) {
      nodes = [{ kind: 'or', children: [...nodes, ...conditionNodes(orResult.conditions)] }];
    }
  } else if (logical.OR !== undefined) {
    const orResult = buildGroupList('or', logical.OR, depth);
    if (!orResult.ok) return orResult;
    if (orResult.where) nodes.push(orResult.where);
  }

  if (logical.AND !== undefined) {
    const andResult = buildGroupList('and', logical.AND, depth);
    if (!andResult.ok) return andResult;
    if (andResult.where) nodes.push(andResult.where);
  }

  if (!nodes.length) return { ok: true, where: null };
  return { ok: true, where: nodes.length === 1 ? nodes[0] : { kind: 'and', children: nodes } };
};

const countConditions = (node: IFilterNode): number =>
  node.kind === 'condition' ? 1 : node.children.reduce((sum, child) => sum + countConditions(child), 0);

/**
 * Validates the filters object and compiles it into one AND/OR tree. Never
 * throws — a caller-supplied filter is untrusted input, not a programmer
 * error, so a bad field is a normal validation failure the controller turns
 * into a 400.
 */
const validateAndBuildFilters = (filters: unknown): IValidateFiltersResult => {
  const built = buildFilterGroup(filters, 0);
  if (!built.ok) return built;
  // Bounds the size of the generated Athena WHERE clause.
  if (built.where && countConditions(built.where) > MAX_FILTER_CONDITIONS) return { ok: false, error: 'invalid_filters' };
  return built;
};

const validateFields = (fields: unknown): { ok: true; fields: string[] | null } | { ok: false } => {
  // Optional: omitted, null or [] all mean "every column".
  if (fields === undefined || fields === null || (Array.isArray(fields) && !fields.length)) return { ok: true, fields: null };
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

  const schema = await readSchemaFile(getDecryptedDestinationConfig(destination) as IS3Config, {
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
// Usable as the top-level `dateFilters` (always ANDed) or, with the same
// { from, to } value, as a field inside `filters` (so it can sit in an OR group).
interface IArchivalDateRange {
  from?: string;
  to?: string;
}
type IArchivalDateFilters = Record<string, IArchivalDateRange>;

type ICriteriaError = IFilterError;

// Everything a caller can filter rows by, validated and compiled once so the
// search and the detail endpoint apply identical rules.
interface IArchivalCriteria {
  where: IFilterNode | null;
  dates: IFilterCondition[];
}

const DATE_WITH_SPACE_RE = /^(\d{4}-\d{2}-\d{2}) (?=\d)/;

// SQL for one { from?, to? } range on `field`, or null when it is malformed
// (no bound, a bad date, or from after to).
const buildRangeSql = (field: string, range: unknown): string | null => {
  if (!isPlainObject(range)) return null;
  const { from, to } = range as IArchivalDateRange;
  if (from === undefined && to === undefined) return null;

  const instant = datetimeInstant(field);
  const bounds: [unknown, 'start' | 'end', '>=' | '<='][] = [
    [from, 'start', '>='],
    [to, 'end', '<='],
  ];
  const parts: string[] = [];
  let start: IsoDateString | null = null;
  let end: IsoDateString | null = null;
  for (const [raw, bound, operator] of bounds) {
    if (raw === undefined) continue;
    const parsed = typeof raw === 'string' ? toIsoDateString(raw.replace(DATE_WITH_SPACE_RE, '$1T'), bound) : null;
    if (!parsed) return null;
    if (bound === 'start') start = parsed;
    else end = parsed;
    parts.push(`${instant} ${operator} from_iso8601_timestamp('${parsed}')`);
  }
  if (start && end && start > end) return null;
  return parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0];
};

const buildDateConditions = (
  dateFilters: unknown
): { ok: true; conditions: IFilterCondition[] } | { ok: false; error: 'invalid_date_filters' } => {
  if (dateFilters === undefined || dateFilters === null) return { ok: true, conditions: [] };
  if (!isPlainObject(dateFilters)) return { ok: false, error: 'invalid_date_filters' };

  const conditions: IFilterCondition[] = [];
  for (const [field, range] of Object.entries(dateFilters)) {
    const sql = FIELD_NAME_RE.test(field) ? buildRangeSql(field, range) : null;
    if (!sql) return { ok: false, error: 'invalid_date_filters' };
    conditions.push({ field, sql });
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
  return { ok: true, criteria: { where: filterCheck.where, dates: dateCheck.conditions } };
};

// Compiles the tree to one SQL string for a table, given which columns exist.
// A missing column is NULL on every row, so its condition is a constant: an
// equality / IN / range on it is false, a "_ne" / NOT IN on it is true. Constants
// are folded away (AND drops true and is false if any is false; OR drops false
// and is true if any is true), so what comes back is a SQL string, or
// true / false when the filter is decided without querying.
const compileFilterNode = (node: IFilterNode, hasColumn: (c: IFilterCondition) => boolean): string | boolean => {
  if (node.kind === 'condition') {
    return hasColumn(node.condition) ? node.condition.sql : !!node.condition.negated;
  }

  const isOr = node.kind === 'or';
  const parts: string[] = [];
  for (const child of node.children) {
    const compiled = compileFilterNode(child, hasColumn);
    if (typeof compiled === 'string') parts.push(compiled);
    else if (compiled === isOr) return isOr; // OR met a true / AND met a false
  }
  if (!parts.length) return !isOr;
  return parts.length === 1 ? parts[0] : `(${parts.join(isOr ? ' OR ' : ' AND ')})`;
};

// WHERE conditions for one table. `missing` means the table lacks a filtered
// column in a way that rules out every row (see compileFilterNode), so the
// Athena query is skipped — an AND (or date) condition on a missing column would
// fail the whole query and can never match.
const buildTableConditions = async (
  criteria: IArchivalCriteria,
  hudiTable: string,
  databaseName: string,
  region: string
): Promise<{ conditions: string[]; missing: false } | { missing: true }> => {
  if (!criteria.where && !criteria.dates.length) return { conditions: [], missing: false };

  const known = new Set((await getTableColumns(hudiTable, databaseName, region)).map((c) => c.toLowerCase()));
  const hasColumn = (c: IFilterCondition) => known.has(c.field.toLowerCase());

  if (!criteria.dates.every(hasColumn)) return { missing: true };
  const conditions = criteria.dates.map((c) => c.sql);

  if (criteria.where) {
    const compiled = compileFilterNode(criteria.where, hasColumn);
    if (compiled === false) return { missing: true };
    if (compiled !== true) conditions.push(compiled);
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
  // 1-based. Page 1 (or omitted) is the first page. Uses OFFSET, so deep pages
  // get slower — prefer `cursor`.
  page?: number;
  // `nextCursor` from the previous response (the last Id of that page). Reads
  // the rows after it directly (`"Id" > cursor`), so every page costs the same.
  // Takes precedence over `page`.
  cursor?: string;
}

export type ArchivalSearchError =
  | 'invalid_filters'
  | 'invalid_filter_field'
  | 'invalid_date_filters'
  | 'unknown_filter_field'
  | 'invalid_fields'
  | 'invalid_limit'
  | 'invalid_page'
  | 'invalid_cursor';

export interface IArchivalSearchResult {
  records: Record<string, string>[];
  hasMore: boolean;
  page: number;
  // Last Id of this page; present only when hasMore.
  nextCursor?: string;
}

/**
 * Queries every config's Hudi table for objectApiName, merges the rows, and
 * returns one page, ordered by Id.
 *
 * With a `cursor` (the previous page's last Id) every config is asked for
 * `"Id" > cursor ORDER BY "Id" LIMIT limit+1`: Athena keeps just a top-N, skips
 * nothing, and the merged page is exact even across several configs (the
 * smallest `limit` Ids overall are always within each config's own smallest).
 *
 * The legacy `page` path uses LIMIT+OFFSET per config (not a single global
 * offset split across them) — exact for one archival config per object; with
 * several, a page can occasionally hold more or fewer rows than `limit` at a
 * page boundary, and deep pages cost more since Athena must sort and discard
 * every earlier row. The Restore flow's paginated reconstruction (retrieveRecords
 * in restore-retrieve/index.ts) is where exact cross-source pagination lives.
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

  // Optional params: null is treated like omitted.
  const rawLimit = params.limit ?? undefined;
  if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1)) {
    return { ok: false, error: 'invalid_limit' };
  }
  const limit = Math.min(rawLimit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  const rawPage = params.page ?? undefined;
  if (rawPage !== undefined && (typeof rawPage !== 'number' || !Number.isInteger(rawPage) || rawPage < 1)) {
    return { ok: false, error: 'invalid_page' };
  }
  const page = rawPage ?? 1;

  const cursor = params.cursor ?? undefined;
  if (cursor !== undefined && (typeof cursor !== 'string' || !RECORD_ID_RE.test(cursor))) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const offset = cursor ? 0 : (page - 1) * limit;

  // Id is always fetched, even when the caller's `fields` doesn't ask for it —
  // the merge sort and nextCursor below need it on every row.
  // applyFieldSelection trims it back out afterwards if it wasn't requested.
  const perConfigResults = await Promise.all(
    configs.map(async (config) => {
      const prepStartedAt = Date.now();
      const { databaseName, hudiTable } = hudiTableFor(config, params.objectApiName);
      const { region, outputLocation } = await buildArchivalOutputLocation(config);
      if (!(await tableExists(databaseName, hudiTable, region))) return { rows: [], missingFilterField: false };

      const [table, selectClause] = await Promise.all([
        buildTableConditions(criteria, hudiTable, databaseName, region),
        buildSelectClause(config, params.objectApiName, region, fieldsCheck.fields, ['Id']),
      ]);
      if (table.missing) return { rows: [], missingFilterField: true };

      const conditions: string[] = [];
      if (cursor) conditions.push(`"Id" > ${escapeSqlValue(cursor)}`);
      const createdInstant = datetimeInstant('CreatedDate');
      if (params.startDate) conditions.push(`${createdInstant} >= from_iso8601_timestamp('${params.startDate}')`);
      if (params.endDate) conditions.push(`${createdInstant} <= from_iso8601_timestamp('${params.endDate}')`);
      conditions.push(...table.conditions);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // Fetch one extra row past `limit` so hasMore can be determined without
      // a second COUNT query.
      const offsetClause = offset > 0 ? ` OFFSET ${offset}` : '';
      // One row per Id is chosen inside the query (latest Hudi commit when the
      // table has it), before ORDER BY/LIMIT — deduping after the LIMIT would
      // leave the page short by however many duplicates it contained.
      const tableColumns = await getTableColumns(hudiTable, databaseName, region);
      const hasCommitTime = tableColumns.includes('_hoodie_commit_time');
      const latestFirst = hasCommitTime ? '"_hoodie_commit_time" DESC' : '"Id"';
      const rankColumn = hasCommitTime ? ', "_hoodie_commit_time"' : '';
      // Two steps so no full-table sort/shuffle happens: (1) the page's distinct Ids
      // — reads only the Id column, a cheap top-N; (2) the full rows for just those
      // Ids, one per Id. The window runs on ~limit+1 Ids, not on the whole table.
      const pageIds =
        `SELECT "Id" FROM "${hudiTable}" ${where} GROUP BY "Id" ORDER BY "Id"${offsetClause} LIMIT ${limit + 1}`;
      const sql =
        `SELECT ${selectClause} FROM (` +
        `SELECT ${selectClause}${rankColumn}, ROW_NUMBER() OVER (PARTITION BY "Id" ORDER BY ${latestFirst}) AS "__rn" ` +
        `FROM "${hudiTable}" WHERE "Id" IN (${pageIds})) WHERE "__rn" = 1 ORDER BY "Id"`;
      const athenaStartedAt = Date.now();
      const result = await runAthenaQuery(sql, databaseName, region, outputLocation, limit + 1);
      // prepMs = Dynamo/Glue/S3 work before the query; athenaMs = submit + poll + fetch.
      logger.info(
        `[archival-search] timing | table:${hudiTable} prepMs:${athenaStartedAt - prepStartedAt} ` +
        `athenaMs:${Date.now() - athenaStartedAt} rows:${result.rows.length}`
      );
      return { rows: result.rows, missingFilterField: false };
    })
  );

  // Every archived table lacked a filtered column -> the field name is wrong
  // (not merely "no matches"), so say so instead of returning an empty page.
  if (perConfigResults.length && perConfigResults.every((r) => r.missingFilterField)) {
    return { ok: false, error: 'unknown_filter_field' };
  }

  // TEMP-GLUE-WORKAROUND: was sorted by CreatedDate desc. Revert after Glue table fix.
  // Sorted by Id (each config's rows already are) so the page is the smallest
  // Ids overall. Salesforce Ids are ASCII, so this matches Athena's ordering.
  // Athena returns column names as Glue spells them (lower-case), hence getField.
  const idOf = (row: Record<string, string>): string => getField(row, 'Id') ?? '';
  // Each config's rows are already one-per-Id; the same Id can still come back from
  // two configs covering this object, so keep one row per Id across the merge too.
  const seenIds = new Set<string>();
  const merged = perConfigResults
    .flatMap((r) => r.rows)
    .filter((row) => {
      const id = idOf(row);
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    })
    .sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));

  const hasMore = merged.length > limit;
  const pageRows = merged.slice(0, limit);
  const nextCursor = hasMore ? idOf(pageRows[pageRows.length - 1]) : undefined;
  const records = pageRows.map((row) => applyFieldSelection(row, fieldsCheck.fields));

  return {
    ok: true,
    result: { records, hasMore, page, ...(nextCursor && { nextCursor }) },
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
  criteria: IArchivalCriteria = { where: null, dates: [] }
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
  // Several versions of one Id can exist; take the latest Hudi commit when the table has it.
  const hasCommitTime = (await getTableColumns(hudiTable, databaseName, region)).includes('_hoodie_commit_time');
  const orderBy = hasCommitTime ? ' ORDER BY "_hoodie_commit_time" DESC' : '';
  const sql = `SELECT ${selectClause} FROM "${hudiTable}" WHERE ${where}${orderBy} LIMIT 1`;
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
