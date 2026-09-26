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

// Formats a scalar value as a Presto literal by data type. Strings/dates are
// single-quoted and '' -escaped; numbers/booleans render bare. Columns in the
// Glue-backed tables are varchar, so a quoted literal compares correctly
// either way — the bare cases just avoid needless quoting for numeric/boolean
// filters. `value` is IRestoreFilterField's `any`, so it is coerced to a
// string up front.
const formatValue = (raw: unknown, dataType: string): string => {
  const value = String(raw ?? '');
  const type = dataType.toLowerCase();
  if (['integer', 'double', 'decimal', 'currency', 'percent', 'number', 'long'].includes(type)) {
    return value;
  }
  if (type === 'boolean') {
    return /^(true|1|yes)$/i.test(value.trim()) ? 'true' : 'false';
  }
  return `'${value.replace(/'/g, "''")}'`;
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

  if (op === 'IN' || op === 'NOT IN') {
    const items = (Array.isArray(f.value) ? f.value.map(String) : String(f.value ?? '').split(','))
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => formatValue(v, dataType));
    if (items.length === 0) throw new FilterError('invalid_filter_field');
    return `${column} ${op} (${items.join(', ')})`;
  }

  return `${column} ${op} ${formatValue(f.value, dataType)}`;
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

// Minimal view of the soql-parser-js WHERE AST we traverse.
interface WhereNode {
  field?: string;
  operator?: string;
  value?: string | string[];
  literalType?: string;
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
  if (n.valueQuery || n.literalType === 'SUBQUERY') throw new FilterError('soql_subquery_not_supported');
  if (n.literalType && UNSUPPORTED_LITERALS.has(n.literalType)) {
    throw new FilterError('soql_date_filter_not_supported');
  }

  const op = resolveOperator(n.operator ?? '');
  // Parser preserves literal text (strings keep their quotes), so pass-through
  // is already valid Presto for string/number/boolean/null literals.
  const value = Array.isArray(n.value) ? `(${n.value.join(', ')})` : String(n.value ?? '');
  const open = '('.repeat(n.openParen ?? 0);
  const close = ')'.repeat(n.closeParen ?? 0);
  return `${open}${colExpr(field)} ${op} ${value}${close}`;
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

/**
 * Delta-table column resolver for FILTER-scope conditions under
 * CHANGED_BETWEEN: change_data is JSON, not flat columns, and its shape
 * depends on change_type — a DELETE row is a flat snapshot
 * ({"Field": value}), an UPDATE row nests {"Field": {"old":..., "new":...}}
 * per changed field only.
 *
 * ponytail: matches only deltas whose payload actually names the field — an
 * UPDATE delta that didn't touch this field has no value here to compare, so
 * it's excluded even if the record's current (untouched) state would match.
 * Upgrade path: LEFT JOIN the object's _hudi table and COALESCE onto its
 * current value for fields absent from change_data, if a delta filter needs
 * full correctness.
 */
const deltaFieldExpr: ColExpr = (name) => {
  quoteIdentifier(name); // validates; throws FilterError before name is interpolated below
  const del = `json_extract_scalar(change_data, '$["${name}"]')`;
  const upd = `json_extract_scalar(change_data, '$["${name}"]."new"')`;
  return `CASE WHEN change_type = 'DELETE' THEN ${del} ELSE ${upd} END`;
};

export const buildDeltaFilterWhere = (filters: IRestoreFilters): string | null =>
  buildAthenaFilterWhere(filters, deltaFieldExpr);

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

  // AND / OR structured filters
  assert.strictEqual(
    buildAthenaFilterWhere({
      type: 'AND',
      fields: [
        { name: 'Name', dataType: 'String', operator: 'LIKE', value: 'Acme' },
        { name: 'Amount', dataType: 'number', operator: '>=', value: '100' },
      ],
    }),
    `"Name" LIKE '%Acme%' AND "Amount" >= 100`
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

  // SOQL pass-through
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "Name = 'Acme' AND Amount > 100" }),
    `"Name" = 'Acme' AND "Amount" > 100`
  );
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: "SELECT Id FROM Account WHERE Status = 'Active'" }),
    `"Status" = 'Active'`
  );
  // SOQL no WHERE → null
  assert.strictEqual(buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'SELECT Id FROM Account' }), null);

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
  // A custom Geolocation field resolves to its own real sibling the same way.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'Some_Location__c.Latitude > 10' }, undefined, testResolver),
    `"Some_Location__Latitude__s" > 10`
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
  // change_type-aware CASE over json_extract_scalar instead of a plain column.
  assert.strictEqual(
    buildDeltaFilterWhere({ type: 'AND', fields: [{ name: 'Amount', dataType: 'number', operator: '>=', value: '100' }] }),
    `CASE WHEN change_type = 'DELETE' THEN json_extract_scalar(change_data, '$["Amount"]') ELSE json_extract_scalar(change_data, '$["Amount"]."new"') END >= 100`
  );
  // Same operator/value/AND-OR handling as the Hudi path — only the column
  // expression differs.
  assert.strictEqual(
    buildDeltaFilterWhere({ type: 'OR', fields: [{ name: 'Stage', dataType: 'string', operator: 'LIKE', value: 'Won' }] }),
    `CASE WHEN change_type = 'DELETE' THEN json_extract_scalar(change_data, '$["Stage"]') ELSE json_extract_scalar(change_data, '$["Stage"]."new"') END LIKE '%Won%'`
  );
  // Injection defence still fires through the delta path.
  expectError(
    () => buildDeltaFilterWhere({ type: 'AND', fields: [{ name: 'Name; DROP', dataType: 'string', operator: '=', value: 'x' }] }),
    'invalid_filter_field'
  );
  // Omitted colExpr on buildAthenaFilterWhere still defaults to the Hudi path.
  assert.strictEqual(
    buildAthenaFilterWhere({ type: 'AND', fields: [{ name: 'X', dataType: 'string', operator: '=', value: 'y' }] }),
    `"X" = 'y'`
  );

  console.log('athena-filter self-check passed');
}
