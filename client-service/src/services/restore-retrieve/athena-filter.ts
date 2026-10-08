// Referenced explicitly so the self-check at the bottom (`require`, `module`)
// type-checks under `ts-node src/services/restore-retrieve/athena-filter.ts` —
// same directive athena-fetch.ts and restore-reconstruct.ts carry for the same reason.
/// <reference types="node" />

import { parseQuery } from '@jetstreamapp/soql-parser-js';
import type { IRestoreFilters, IRestoreFilterField } from '../../models';

/**
 * Thrown by athena-fetch's column-name validation (and mapped to a 400 by the
 * controller) when a caller-supplied identifier fails the strict column-name
 * pattern — also thrown by buildAthenaFilterWhere below for the same reason,
 * plus unsupported operators/SOQL shapes.
 */
export class FilterError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'FilterError';
  }
}

/**
 * Builds an Athena/Presto WHERE-clause *body* (no leading "WHERE") from an
 * IRestoreFilters block (selection.restoreScope's FILTER scope, or a
 * per-object filter under it). Returns null when the filter carries no
 * conditions. Throws FilterError (with a `.code` the controller maps to a
 * 400) on anything malformed or unsupported — never emits SQL it can't vouch
 * for.
 *
 * Restored from the pre-Hudi /retrieve/show-preview flow (same filter shape,
 * architecture-independent) after that endpoint was replaced by the
 * Hudi/Delta fetch-records model — the conversion itself never depended on
 * which tables it filtered.
 *
 * Trust boundary: every value is client-supplied. Column names are validated
 * against a strict identifier pattern and operators against a fixed
 * whitelist, so neither slot can carry injection; values go through
 * formatValue, which single-quotes and '' -escapes strings.
 */

// Salesforce field API names are [A-Za-z0-9_], first char a letter/underscore.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteIdentifier = (name: string): string => {
  if (!IDENTIFIER.test(name)) throw new FilterError('invalid_filter_field');
  return `"${name}"`;
};

// Resolves a filter field name to the SQL expression to compare against.
// Defaults to a plain quoted column (the Hudi table); the delta table's
// FILTER-scope count instead resolves through deltaFieldExpr below, since its
// fields live inside a JSON column rather than as flat columns of their own.
type ColExpr = (name: string) => string;

// Restore filter operator token (FILTER_OPERATOR's stored symbol, e.g. '>=',
// 'LIKE', 'IN' — see constant/index.ts) → Presto operator. The set is closed:
// an operator outside it is rejected, so the operator slot can never carry
// arbitrary SQL. A couple of SOQL-style spellings ('<>', 'NOT LIKE', 'NOT IN')
// are accepted too since the SOQL filter path below can emit them.
const OPERATORS: Record<string, string> = {
  '=': '=',
  '!=': '<>',
  '<>': '<>',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
  LIKE: 'LIKE',
  'NOT LIKE': 'NOT LIKE',
  IN: 'IN',
  'NOT IN': 'NOT IN',
};

const resolveOperator = (raw: string): string => {
  const op = OPERATORS[raw.toUpperCase()];
  if (!op) throw new FilterError('invalid_filter_operator');
  return op;
};

// Every column in the Glue-backed tables (Hudi main, delta, archival) is
// varchar end to end — see backup-service's toGlueColumnType, which types
// everything 'string' except archival's native-Parquet datetime columns.
// Presto/Trino gives no implicit varchar<->number/boolean coercion for ANY
// operator (TYPE_MISMATCH: "Cannot apply operator: varchar < integer"), so a
// numeric/boolean comparison has to CAST the column to match, not just format
// the literal — see castColumnForDataType below, which this type set feeds.
const NUMERIC_DATA_TYPES = new Set(['integer', 'double', 'decimal', 'currency', 'percent', 'number', 'long']);

// Formats a scalar value as a Presto literal by data type. Numbers/booleans
// render bare (the column side is cast to match, see castColumnForDataType);
// everything else is single-quoted and '' -escaped. `value` is
// IRestoreFilterField's `any`, so it is coerced to a string up front.
const formatValue = (raw: unknown, dataType: string): string => {
  const value = String(raw ?? '');
  const type = dataType.toLowerCase();
  if (NUMERIC_DATA_TYPES.has(type)) {
    return value;
  }
  if (type === 'boolean') {
    return /^(true|1|yes)$/i.test(value.trim()) ? 'true' : 'false';
  }
  return `'${value.replace(/'/g, "''")}'`;
};

// Casts a varchar column to the real type a numeric/boolean comparison needs.
// Without this, "CAST-less" comparisons against a text column don't just
// error on Presto (TYPE_MISMATCH) — a plain string compare that DID somehow
// typecheck would still silently misorder numbers by digit count ("1000" <
// "500" lexicographically), so the column is cast rather than the literal
// quoted as text. String/picklist/date fields are left as plain varchar —
// correct for =, !=, and LIKE alike.
const castColumnForDataType = (column: string, dataType: string): string => {
  const type = dataType.toLowerCase();
  if (NUMERIC_DATA_TYPES.has(type)) return `CAST(${column} AS double)`;
  if (type === 'boolean') return `CAST(${column} AS boolean)`;
  return column;
};

// ── Structured AND / OR filters ───────────────────────────────────────────────

// Formats a LIKE pattern: '' -escape, then wrap with % when the caller
// supplied no wildcard of their own.
const formatLike = (raw: unknown): string => {
  const escaped = String(raw ?? '').replace(/'/g, "''");
  const pattern = /[%_]/.test(escaped) ? escaped : `%${escaped}%`;
  return `'${pattern}'`;
};

const buildFieldCondition = (f: IRestoreFilterField, colExpr: ColExpr): string => {
  const column = colExpr(f.name);
  const op = resolveOperator(f.operator);
  const dataType = f.dataType || 'string';

  if (op === 'LIKE' || op === 'NOT LIKE') {
    return `${column} ${op} ${formatLike(f.value)}`;
  }

  // LIKE above stays on the raw varchar column; every other operator against
  // a numeric/boolean field needs it cast (see castColumnForDataType).
  const comparisonColumn = castColumnForDataType(column, dataType);

  if (op === 'IN' || op === 'NOT IN') {
    const items = (Array.isArray(f.value) ? f.value.map(String) : String(f.value ?? '').split(','))
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => formatValue(v, dataType));
    if (items.length === 0) throw new FilterError('invalid_filter_field');
    return `${comparisonColumn} ${op} (${items.join(', ')})`;
  }

  return `${comparisonColumn} ${op} ${formatValue(f.value, dataType)}`;
};

const buildStructuredWhere = (
  fields: IRestoreFilterField[],
  joiner: ' AND ' | ' OR ',
  colExpr: ColExpr
): string | null => {
  if (fields.length === 0) return null;
  return fields.map((f) => buildFieldCondition(f, colExpr)).join(joiner);
};

// ── SOQL filters ──────────────────────────────────────────────────────────────

// Minimal view of the soql-parser-js WHERE AST we traverse. literalType is an
// array, not a bare string, when value is itself an array with mixed/uniform
// literal kinds per element (e.g. "Foo IN (1, 2)" -> ['INTEGER','INTEGER']).
type LiteralType = string | string[];

interface WhereNode {
  field?: string;
  operator?: string;
  value?: string | string[];
  literalType?: LiteralType;
  valueQuery?: unknown;
  openParen?: number;
  closeParen?: number;
  left?: WhereNode;
  right?: WhereNode;
}

// Literal kinds that don't translate 1:1 to Presto (SOQL date literals like
// TODAY / LAST_N_DAYS:7, and bare date/datetime literals). Rejected rather
// than mistranslated.
// ponytail: no date-literal translation. Upgrade path: map each SOQL date
// literal to a Presto expression keyed on the Glue column type when a real
// query needs it.
const UNSUPPORTED_LITERALS = new Set(['DATE_LITERAL', 'DATE_N_LITERAL', 'DATE', 'DATETIME']);

// soql-parser-js's own LiteralType values for a numeric literal — tells us a
// bare "> 1000" needs the varchar column cast (see castColumnForDataType's
// comment; same TYPE_MISMATCH reasoning applies here).
const NUMERIC_LITERAL_TYPES = new Set([
  'INTEGER',
  'DECIMAL',
  'INTEGER_WITH_CURRENCY_PREFIX',
  'DECIMAL_WITH_CURRENCY_PREFIX',
]);

// A field's canonical (describe-correct) name + Salesforce describe type,
// keyed case-insensitively — built by the caller (validateSoqlQuery) from a
// live describe response.
export interface ISoqlFieldMeta {
  name: string;
  type: string;
}

// Real, describe-backed lookups the caller (validateSoqlQuery) builds from a
// live Salesforce describe response — no compound-field naming convention is
// hardcoded or guessed anywhere in this module. Optional everywhere below:
// omitted, every existing caller (dry-run's FILTER scope, the delta path)
// keeps today's exact behavior — any dotted field still rejects immediately.
export interface FieldTypeResolver {
  resolve: (fieldName: string) => ISoqlFieldMeta | undefined;
  // Finds the compound sibling of `base` (a compound field's own API name,
  // e.g. "MailingAddress") whose real field name contains `sub` as a
  // substring (case-insensitive) — via Schema.compoundFieldName, the same
  // link Salesforce's own describe uses to group a compound field's
  // flattened children (e.g. "MailingCity".compoundFieldName ===
  // "MailingAddress"). Substring, not endsWith: a standard sibling appends
  // the sub-component directly ("MailingCity"), but a custom compound
  // field's sibling wraps it ("Some_Location__Latitude__s") — safe either
  // way since candidates are already narrowed to siblings of the same
  // compound parent, a small, mutually-distinct set (Street/City/.../
  // Latitude/Longitude/...).
  resolveCompoundSibling: (base: string, sub: string) => ISoqlFieldMeta | undefined;
}

const renderSoqlLeaf = (n: WhereNode, colExpr: ColExpr, resolver?: FieldTypeResolver): string => {
  let field = n.field ?? '';
  if (field.includes('.')) {
    const parts = field.split('.');
    // More than one dot is always a multi-hop relationship traversal — never
    // a compound sub-field access — rejected regardless of resolver.
    if (parts.length !== 2) throw new FilterError('soql_relationship_not_supported');

    const [base, sub] = parts;
    const baseMeta = resolver?.resolve(base);
    if (!baseMeta || (baseMeta.type !== 'address' && baseMeta.type !== 'location')) {
      throw new FilterError('soql_relationship_not_supported');
    }

    const siblingMeta = resolver!.resolveCompoundSibling(baseMeta.name, sub);
    if (!siblingMeta) throw new FilterError('soql_relationship_not_supported');
    field = siblingMeta.name;
  }
  const literalTypes = n.literalType === undefined ? [] : Array.isArray(n.literalType) ? n.literalType : [n.literalType];

  if (n.valueQuery || literalTypes.includes('SUBQUERY')) throw new FilterError('soql_subquery_not_supported');
  if (literalTypes.some((t) => UNSUPPORTED_LITERALS.has(t))) {
    throw new FilterError('soql_date_filter_not_supported');
  }

  const op = resolveOperator(n.operator ?? '');
  const open = '('.repeat(n.openParen ?? 0);
  const close = ')'.repeat(n.closeParen ?? 0);

  // `= NULL` / `<> NULL` are never TRUE in SQL (NULL compared this way is
  // UNKNOWN, not TRUE), so a bare pass-through silently excludes every row —
  // matching SOQL's `= null` / `!= null` semantics requires IS [NOT] NULL.
  if (literalTypes.length === 1 && literalTypes[0] === 'NULL') {
    if (op === '=') return `${open}${colExpr(field)} IS NULL${close}`;
    if (op === '<>') return `${open}${colExpr(field)} IS NOT NULL${close}`;
    throw new FilterError('invalid_filter_operator');
  }

  // Parser preserves literal text (strings keep their quotes), so pass-through
  // is already valid Presto for string literals. Numeric/boolean literals
  // need the varchar column cast to match (same reasoning as
  // castColumnForDataType) — soql_parser_js's own literalType (INTEGER,
  // DECIMAL, BOOLEAN, ...) is what tells us which, independent of whether a
  // FieldTypeResolver was even passed in.
  const column =
    literalTypes.length > 0 && literalTypes.every((t) => NUMERIC_LITERAL_TYPES.has(t))
      ? `CAST(${colExpr(field)} AS double)`
      : literalTypes.length > 0 && literalTypes.every((t) => t === 'BOOLEAN')
        ? `CAST(${colExpr(field)} AS boolean)`
        : colExpr(field);
  const value = Array.isArray(n.value) ? `(${n.value.join(', ')})` : String(n.value ?? '');
  return `${open}${column} ${op} ${value}${close}`;
};

const renderSoqlWhere = (n: WhereNode | null | undefined, colExpr: ColExpr, resolveField?: FieldTypeResolver): string => {
  if (!n) return '';
  if (n.field) return renderSoqlLeaf(n, colExpr, resolveField);
  const left = renderSoqlWhere(n.left, colExpr, resolveField);
  const right = renderSoqlWhere(n.right, colExpr, resolveField);
  if (!right) return left;
  // At a branch node the operator is the AND / OR connective.
  return `${left} ${n.operator} ${right}`;
};

// soql-parser-js can't tokenize Salesforce's bare (unquoted) Time literal
// syntax (HH:mm:ss[.SSS][Z|±hh:mm]) at all — parseQuery throws a confusing,
// unrelated error for it ("Mismatched parentheses...") instead of failing
// cleanly. Unlike DATE/DATETIME (which the parser handles fine and this
// module just declines to translate via UNSUPPORTED_LITERALS above), there's
// no post-parse literalType to check here since parsing itself never
// succeeds — caught before parsing instead, with the same clear rejection.
const BARE_TIME_LITERAL_RE = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?\b/;

const buildSoqlWhere = (soqlQuery: string, colExpr: ColExpr, resolveField?: FieldTypeResolver): string | null => {
  const trimmed = soqlQuery.trim();
  if (!trimmed) return null;

  const withoutStringLiterals = trimmed.replace(/'(?:[^']|'')*'/g, "''");
  if (BARE_TIME_LITERAL_RE.test(withoutStringLiterals)) {
    throw new FilterError('soql_time_filter_not_supported');
  }

  // Accept either a full "SELECT ... FROM ... WHERE ..." or a bare WHERE body.
  const wrapped = /^SELECT\b/i.test(trimmed)
    ? trimmed
    : `SELECT Id FROM X WHERE ${trimmed.replace(/^WHERE\s+/i, '')}`;

  let ast;
  try {
    ast = parseQuery(wrapped);
  } catch {
    throw new FilterError('invalid_soql');
  }

  const body = renderSoqlWhere(ast.where as unknown as WhereNode, colExpr, resolveField).trim();
  return body || null;
};

// ── Entry point ───────────────────────────────────────────────────────────────

// resolveField is optional and SOQL-only (the AND/OR structured branch never
// carries a dotted field) — omitted, a dotted field always rejects exactly as
// before. Only validateSoqlQuery (POST /retrieve/validate-query) builds and
// passes a real resolver, from a live Salesforce describe.
export const buildAthenaFilterWhere = (
  filters: IRestoreFilters,
  colExpr: ColExpr = quoteIdentifier,
  resolveField?: FieldTypeResolver
): string | null => {
  if (filters.type === 'SOQL') return buildSoqlWhere(filters.soqlQuery ?? '', colExpr, resolveField);
  const joiner = filters.type === 'OR' ? ' OR ' : ' AND ';
  return buildStructuredWhere(filters.fields ?? [], joiner, colExpr);
};

// Column aliases buildDeltaCountSql (athena-fetch.ts) flattens change_type/
// record_id into after LEFT JOINing each record's current Hudi row onto its
// deduped-latest delta event — dv_-prefixed the same way dv_operation/
// dv_created are, since that join also flattens in every real Hudi column
// (h.*) alongside these, and an object field literally named "change_type"/
// "record_id" would otherwise collide. DELTA_RECORD_ID_ALIAS in particular is
// what a correlated subquery below binds back to — bare "record_id" would
// instead shadow onto the subquery's OWN record_id column, silently breaking
// the correlation.
export const DELTA_CHANGE_TYPE_ALIAS = 'dv_change_type';
export const DELTA_RECORD_ID_ALIAS = 'dv_record_id';

// Context buildDeltaFieldExpr needs to build its per-field correlated
// subquery — passed in rather than re-derived, so the window/partition
// predicate this scans by is always the exact one buildDeltaCountSql's own
// record-level dedup already scans by (buildDeltaScanWhere in athena-fetch.ts
// builds both).
export interface IDeltaFilterContext {
  deltaTable: string;
  scanWhere: string;
}

/**
 * Delta-table column resolver for FILTER-scope conditions under
 * CHANGED_BETWEEN, matching each record's PRE-WINDOW value — the value a
 * field held immediately before this window's changes, i.e. what a restore
 * of this window actually reverts a matching record back to.
 *
 * Correlated per referenced field, not a single record-level dedup: two
 * fields on the same record can have been touched by two different,
 * non-overlapping events inside the window, so there is no single "the"
 * earliest row the way buildDeltaCountSql's classification has a single
 * "the latest row" — each field needs its own earliest touching event.
 *
 *   1. Find this record's chronologically FIRST in-window event that names
 *      this field — an UPDATE's {"old":...,"new":...} entry, or (a DELETE
 *      snapshot being flat, not nested) the DELETE's own value. Either way,
 *      being the first touching event means the field had not yet changed
 *      at that point, so that value IS the pre-window one.
 *   2. A field no in-window event touched at all didn't change in the
 *      window, so its pre-window value equals its current one — falls back
 *      to the joined Hudi row.
 *
 * A record whose pre-window value for this field predates the window
 * entirely (never touched before OR during it) AND has no Hudi row to fall
 * back to (deleted within the window) resolves to SQL NULL — a non-match,
 * rather than a guess. Reaching further back than the window for a deleted
 * record's field history isn't attempted.
 */
const buildDeltaFieldExpr = (ctx: IDeltaFilterContext): ColExpr => (name) => {
  const hudiCol = quoteIdentifier(name); // validates; throws FilterError before name is interpolated below
  const touchesField =
    `(change_type = 'DELETE' AND json_extract_scalar(change_data, '$["${name}"]') IS NOT NULL) OR ` +
    `(change_type <> 'DELETE' AND json_extract_scalar(change_data, '$["${name}"]["old"]') IS NOT NULL)`;
  const priorValue =
    `SELECT CASE WHEN change_type = 'DELETE' ` +
    `THEN json_extract_scalar(change_data, '$["${name}"]') ` +
    `ELSE json_extract_scalar(change_data, '$["${name}"]["old"]') END ` +
    `FROM "${ctx.deltaTable}" WHERE record_id = "${DELTA_RECORD_ID_ALIAS}" AND ${ctx.scanWhere} ` +
    `AND (${touchesField}) ORDER BY change_time ASC LIMIT 1`;
  return `COALESCE((${priorValue}), CAST(${hudiCol} AS varchar))`;
};

export const buildDeltaFilterWhere = (filters: IRestoreFilters, ctx: IDeltaFilterContext): string | null =>
  buildAthenaFilterWhere(filters, buildDeltaFieldExpr(ctx));

// ── Self-check ────────────────────────────────────────────────────────────────
// Run: npx ts-node src/services/restore-retrieve/athena-filter.ts
if (require.main === module) {
  const assert: typeof import('assert') = require('assert');

  const expectError = (fn: () => unknown, code: string) => {
    try {
      fn();
      assert.fail(`expected FilterError:${code}`);
    } catch (e) {
      assert.ok(e instanceof FilterError && e.code === code, `wrong error: ${(e as Error).message}`);
    }
  };

  // AND / OR structured filters. Numeric dataType casts the column (not the
  // literal) — the Glue column is varchar, and Presto gives no implicit
  // varchar<->number coercion for ANY operator (reported bug: ">" against a
  // currency field failed TYPE_MISMATCH: "Cannot apply operator: varchar <
  // integer"). LIKE stays on the raw varchar column either way.
  assert.strictEqual(
    buildAthenaFilterWhere({
      type: 'AND',
      fields: [
        { name: 'Name', dataType: 'String', operator: 'LIKE', value: 'Acme' },
        { name: 'Amount', dataType: 'number', operator: '>=', value: '100' },
      ],
    }),
    `"Name" LIKE '%Acme%' AND CAST("Amount" AS double) >= 100`
  );
  // Boolean dataType casts to boolean the same way.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'IsActive', dataType: 'boolean', operator: '=', value: 'true' }] }),
    `CAST("IsActive" AS boolean) = true`
  );
  // Numeric IN-list casts the column too, not just each item's formatting.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'Amount', dataType: 'number', operator: 'IN', value: '100,200' }] }),
    `CAST("Amount" AS double) IN (100, 200)`
  );
  assert.strictEqual(
    buildAthenaFilterWhere({
      type: 'OR',
      fields: [
        { name: 'Stage', dataType: 'string', operator: '=', value: "O'Brien" },
        { name: 'Type', dataType: 'string', operator: 'IN', value: 'A, B' },
      ],
    }),
    `"Stage" = 'O''Brien' OR "Type" IN ('A', 'B')`
  );
  // != maps to Presto <>
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'X', dataType: 'string', operator: '!=', value: 'y' }] }),
    `"X" <> 'y'`
  );
  // Empty fields → no filter
  assert.strictEqual(buildAthenaFilterWhere({ type: 'AND', fields: [] }), null);

  // Injection defence
  expectError(
    () => buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'Name; DROP', dataType: 'string', operator: '=', value: 'x' }] }),
    'invalid_filter_field'
  );
  expectError(
    () => buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'Name', dataType: 'string', operator: 'OR 1=1', value: 'x' }] }),
    'invalid_filter_operator'
  );

  // SOQL pass-through. A numeric literal (parser literalType INTEGER/DECIMAL)
  // casts the column the same way the structured path's dataType does — this
  // is the exact reported bug: "Annual_Bonus__c > 1000" against a varchar
  // Hudi column, which Presto rejects outright without the cast.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Name = 'Acme' AND Amount > 100" }),
    `"Name" = 'Acme' AND CAST("Amount" AS double) > 100`
  );
  // Bare boolean literal casts to boolean too (soql-parser-js normalizes the
  // literal text to uppercase TRUE — still valid, case-insensitive Presto).
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'IsActive = true' }),
    `CAST("IsActive" AS boolean) = TRUE`
  );
  // A quoted numeric-looking string is a STRING literal, not INTEGER — no
  // cast, plain varchar compare (this is a caller choice, not something to
  // second-guess here).
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Amount = '100'" }),
    `"Amount" = '100'`
  );
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "SELECT Id FROM Account WHERE Status = 'Active'" }),
    `"Status" = 'Active'`
  );
  // SOQL no WHERE → null
  assert.strictEqual(buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'SELECT Id FROM Account' }), null);

  // `!= null` / `= null` must become IS [NOT] NULL — `<> NULL` is never TRUE
  // in SQL, so a bare pass-through would silently drop every matching row.
  assert.strictEqual(buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'Name != null' }), `"Name" IS NOT NULL`);
  assert.strictEqual(buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'Name = null' }), `"Name" IS NULL`);

  // SOQL unsupported surfaces
  expectError(() => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Owner.Name = 'x'" }), 'soql_relationship_not_supported');
  expectError(() => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'CreatedDate = LAST_N_DAYS:7' }), 'soql_date_filter_not_supported');
  // A bare Time literal can't even be parsed (soql-parser-js throws its own
  // confusing error for the colons) — caught before parsing, same as the
  // other unsupported literal kinds above.
  expectError(() => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'Time_Test__c = 10:30:00.000Z' }), 'soql_time_filter_not_supported');
  // A quoted string that merely looks time-like must not be mistaken for one.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Name = 'Meeting at 10:30:00'" }),
    `"Name" = 'Meeting at 10:30:00'`
  );
  expectError(() => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'this is not soql !!' }), 'invalid_soql');

  // ── Compound Address/Geolocation fields (resolver-gated) ─────────────────────
  // Fixture mirrors what a real describe response's fields[] carries —
  // compoundFieldName links a flat sibling back to its compound parent,
  // exactly like Salesforce's own describe metadata (e.g. "MailingCity"
  // .compoundFieldName === "MailingAddress").
  interface IFixtureField { name: string; type: string; compoundFieldName: string | null; }
  const fixtureFields: IFixtureField[] = [
    { name: 'MailingAddress', type: 'address', compoundFieldName: null },
    { name: 'MailingCity', type: 'string', compoundFieldName: 'MailingAddress' },
    { name: 'MailingStreet', type: 'string', compoundFieldName: 'MailingAddress' },
    { name: 'Some_Location__c', type: 'location', compoundFieldName: null },
    { name: 'Some_Location__Latitude__s', type: 'double', compoundFieldName: 'Some_Location__c' },
    { name: 'Some_Location__Longitude__s', type: 'double', compoundFieldName: 'Some_Location__c' },
    { name: 'OwnerId', type: 'reference', compoundFieldName: null },
  ];
  const fixtureMetaByName = new Map(fixtureFields.map((f) => [f.name.toLowerCase(), { name: f.name, type: f.type }]));
  const testResolver: FieldTypeResolver = {
    resolve: (name) => fixtureMetaByName.get(name.toLowerCase()),
    resolveCompoundSibling: (base, sub) => {
      const subLower = sub.toLowerCase();
      const match = fixtureFields.find(
        (f) => f.compoundFieldName?.toLowerCase() === base.toLowerCase() && f.name.toLowerCase().includes(subLower)
      );
      return match ? { name: match.name, type: match.type } : undefined;
    },
  };

  // A standard Address compound field resolves to its native flat sibling,
  // found via compoundFieldName — no prefix convention hardcoded here.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "MailingAddress.City = 'Austin'" }, undefined, testResolver),
    `"MailingCity" = 'Austin'`
  );
  // A custom Geolocation field resolves to its own real sibling the same way
  // — and still gets the numeric-literal cast, same as any other field.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'Some_Location__c.Latitude > 10' }, undefined, testResolver),
    `CAST("Some_Location__Latitude__s" AS double) > 10`
  );
  // Two dots is always a relationship traversal, never a compound sub-field —
  // rejected regardless of resolver.
  expectError(
    () => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Account.Owner.Name = 'x'" }, undefined, testResolver),
    'soql_relationship_not_supported'
  );
  // One dot, but the base field isn't address/location-typed (a real
  // relationship) — still rejected even with a resolver present.
  expectError(
    () => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Owner.Name = 'x'" }, undefined, testResolver),
    'soql_relationship_not_supported'
  );
  // One dot, address/location-typed base, but no real sibling ends with the
  // requested sub-component — rejected, not emitted as SQL against a
  // nonexistent column.
  expectError(
    () => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "MailingAddress.NoSuchSubField = 'x'" }, undefined, testResolver),
    'soql_relationship_not_supported'
  );
  // Omitting the resolver entirely preserves every existing assertion above
  // unchanged — dry-run's FILTER scope and the delta path never pass one.
  expectError(
    () => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "MailingAddress.City = 'Austin'" }),
    'soql_relationship_not_supported'
  );

  // Delta-table FILTER (buildDeltaFilterWhere): fields resolve through a
  // per-field correlated subquery for the record's PRE-WINDOW value — its
  // earliest in-window touching event's OLD value, falling back to the
  // joined Hudi column when no in-window event touched this field at all.
  const deltaCtx = { deltaTable: 't_delta', scanWhere: 'SCAN_WHERE' };
  const amountDelta = buildDeltaFilterWhere(
    { type: 'AND', fields: [{ name: 'Amount', dataType: 'number', operator: '>=', value: '100' }] },
    deltaCtx
  )!;
  // Numeric dataType casts the WHOLE colExpr result (the COALESCE, not just
  // a plain column) — the delta path's column expression is varchar end to
  // end too (json_extract_scalar and the Hudi fallback are both cast to
  // varchar already), so it needs exactly the same outer CAST.
  assert.ok(
    amountDelta.startsWith(`CAST(COALESCE((SELECT CASE WHEN change_type = 'DELETE'`),
    'DELETE\'s flat snapshot is read directly, no nested old/new'
  );
  assert.ok(
    amountDelta.includes(`ELSE json_extract_scalar(change_data, '$["Amount"]["old"]') END`),
    'non-DELETE branch reads the OLD side of the change, not NEW'
  );
  assert.ok(
    amountDelta.includes(`FROM "t_delta" WHERE record_id = "dv_record_id" AND SCAN_WHERE`),
    'correlates to the outer record via the dv_-aliased id, scanning the same window/partition predicate the count query uses'
  );
  assert.ok(
    amountDelta.includes(`ORDER BY change_time ASC LIMIT 1`),
    'takes the EARLIEST touching event, not the latest — a later event\'s OLD is only an intermediate value, not the true pre-window one'
  );
  assert.ok(
    amountDelta.endsWith(`CAST("Amount" AS varchar)) AS double) >= 100`),
    'falls back to the joined Hudi column when untouched; operator/value binds outside the inner COALESCE but inside the outer numeric CAST'
  );
  // Same operator/value/AND-OR handling as the Hudi path — only the column
  // expression differs.
  assert.ok(
    buildDeltaFilterWhere(
      { type: 'OR', fields: [{ name: 'Stage', dataType: 'string', operator: 'LIKE', value: 'Won' }] },
      deltaCtx
    )!.includes(`$["Stage"]["old"]`)
  );
  // Injection defence still fires through the delta path.
  expectError(
    () => buildDeltaFilterWhere({ type: 'AND', fields: [{ name: 'Name; DROP', dataType: 'string', operator: '=', value: 'x' }] }, deltaCtx),
    'invalid_filter_field'
  );
  // Omitted colExpr on buildAthenaFilterWhere still defaults to the Hudi path.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'X', dataType: 'string', operator: '=', value: 'y' }] }),
    `"X" = 'y'`
  );

  console.log('athena-filter self-check passed');
}
