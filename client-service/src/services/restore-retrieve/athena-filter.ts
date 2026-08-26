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

const buildFieldCondition = (f: IRestoreFilterField): string => {
  const column = quoteIdentifier(f.name);
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

const buildStructuredWhere = (fields: IRestoreFilterField[], joiner: ' AND ' | ' OR '): string | null => {
  if (fields.length === 0) return null;
  return fields.map(buildFieldCondition).join(joiner);
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

const renderSoqlLeaf = (n: WhereNode): string => {
  const field = n.field ?? '';
  if (field.includes('.')) throw new FilterError('soql_relationship_not_supported');
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
  return `${open}${quoteIdentifier(field)} ${op} ${value}${close}`;
};

const renderSoqlWhere = (n: WhereNode | null | undefined): string => {
  if (!n) return '';
  if (n.field) return renderSoqlLeaf(n);
  const left = renderSoqlWhere(n.left);
  const right = renderSoqlWhere(n.right);
  if (!right) return left;
  // At a branch node the operator is the AND / OR connective.
  return `${left} ${n.operator} ${right}`;
};

const buildSoqlWhere = (soqlQuery: string): string | null => {
  const trimmed = soqlQuery.trim();
  if (!trimmed) return null;

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

  const body = renderSoqlWhere(ast.where as unknown as WhereNode).trim();
  return body || null;
};

// ── Entry point ───────────────────────────────────────────────────────────────

export const buildAthenaFilterWhere = (filters: IRestoreFilters): string | null => {
  if (filters.type === 'SOQL') return buildSoqlWhere(filters.soqlQuery ?? '');
  const joiner = filters.type === 'OR' ? ' OR ' : ' AND ';
  return buildStructuredWhere(filters.fields ?? [], joiner);
};

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
  expectError(() => buildAthenaFilterWhere({ type: 'SOQL', soqlQuery: 'this is not soql !!' }), 'invalid_soql');

  console.log('athena-filter self-check passed');
}
