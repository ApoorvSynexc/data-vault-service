import { parseQuery } from '@jetstreamapp/soql-parser-js';
import type { ISalesforceObject } from './types';

// ── Internal AST node shape ───────────────────────────────────────────────────
// Mirrors the soql-parser-js AST structure we traverse; cast from the
// library's WhereClause type via `as unknown as WhereNode`.

interface WhereNode {
  field?: string;
  operator?: string;
  value?: string | string[];
  literalType?: string;
  valueQuery?: {
    fields: Array<{ field: string }>;
    sObject: string;
    where?: WhereNode;
  };
  openParen?: number;
  closeParen?: number;
  left?: WhereNode;
  right?: WhereNode;
}

// ── Date literal handling ─────────────────────────────────────────────────────

const DATE_LITERALS = new Set([
  'TODAY', 'YESTERDAY', 'TOMORROW',
  'LAST_WEEK', 'THIS_WEEK', 'NEXT_WEEK',
  'LAST_MONTH', 'THIS_MONTH', 'NEXT_MONTH',
  'LAST_90_DAYS', 'NEXT_90_DAYS',
  'LAST_QUARTER', 'THIS_QUARTER', 'NEXT_QUARTER',
  'LAST_YEAR', 'THIS_YEAR', 'NEXT_YEAR',
  'LAST_FISCAL_QUARTER', 'THIS_FISCAL_QUARTER', 'NEXT_FISCAL_QUARTER',
  'LAST_FISCAL_YEAR', 'THIS_FISCAL_YEAR', 'NEXT_FISCAL_YEAR',
]);

function isDateLiteral(value: string): boolean {
  return (
    DATE_LITERALS.has(value.toUpperCase()) ||
    /^(LAST|NEXT)_N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS):\d+$/i.test(value)
  );
}

function quoteValue(value: string | number | boolean | null): string | number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value === null || value === 'null') return 'null';
  if (typeof value === 'string' && isDateLiteral(value)) return value;
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

function buildFieldCondition(f: { name: string; filter: { value: string; operator: string } }): string {
  const { value, operator } = f.filter;

  if (operator === 'LIKE') {
    const wrapped = String(value).includes('%') ? value : `%${value}%`;
    return `${f.name} LIKE '${String(wrapped).replace(/'/g, "\\'")}'`;
  }

  if (operator === 'IN') {
    const values = Array.isArray(value) ? value : [value];
    return `${f.name} IN (${values.map(v => quoteValue(v)).join(', ')})`;
  }

  return `${f.name} ${operator} ${quoteValue(value)}`;
}

// ── Own WHERE body ────────────────────────────────────────────────────────────
// Returns the WHERE clause body (no leading "WHERE") for a single object node.
// Returns null when the object has no filter conditions.

export function buildOwnWhereBody(obj: Pick<ISalesforceObject, 'condition' | 'field'>): string | null {
  const { condition, field } = obj;
  if (!condition) return null;

  if (condition.type === 'SOQL') {
    if (!condition.soqlQuery) return null;
    const body = condition.soqlQuery.trim().replace(/^WHERE\s+/i, '');
    return body || null;
  }

  if (!field || field.length === 0) return null;

  const conditions = field.map(buildFieldCondition);

  if (condition.type === 'AND') return conditions.join(' AND ');
  if (condition.type === 'OR') return conditions.join(' OR ');
  if (condition.type === 'CUSTOM') {
    return condition.expression.replace(/\d+/g, n => conditions[parseInt(n, 10) - 1] ?? n);
  }

  return null;
}

// ── Subquery detection ────────────────────────────────────────────────────────

export function hasSubquery(whereBody: string): boolean {
  return (
    /\bIN\s*\(\s*SELECT\b/i.test(whereBody) ||
    /\bNOT\s+IN\s*\(\s*SELECT\b/i.test(whereBody)
  );
}

// ── Relationship path helpers ─────────────────────────────────────────────────

function toRelationshipName(fieldApiName: string): string {
  if (!fieldApiName) return '';
  if (fieldApiName.endsWith('__c')) return `${fieldApiName.slice(0, -3)}__r`;
  if (fieldApiName.endsWith('Id')) return fieldApiName.slice(0, -2);
  return fieldApiName;
}

/**
 * Returns the dot-notation relationship path from the current object up to
 * ancestor at index `i` in `ancestorChain` (root=0, direct parent=last).
 */
function getRelPathToAncestor(
  currentObj: Pick<ISalesforceObject, 'fieldApiName'>,
  ancestorChain: Pick<ISalesforceObject, 'fieldApiName'>[],
  i: number
): string {
  const D = ancestorChain.length;
  const parts = [toRelationshipName(currentObj.fieldApiName!)];
  for (let j = D - 1; j > i; j--) {
    parts.push(toRelationshipName(ancestorChain[j].fieldApiName!));
  }
  return parts.join('.');
}

// ── WHERE clause transformer ──────────────────────────────────────────────────
// Prepends every field reference in an ancestor's WHERE body with the given
// relationship path so it can be used as a cross-object filter on a child.
//
// depth 1: `Industry = 'Tech'`           → `Account.Industry = 'Tech'`
// depth 2: `Account.Industry = 'Tech'`   → `Contact.Account.Industry = 'Tech'`

function rebuildSubquery(subAst: NonNullable<WhereNode['valueQuery']>): string {
  const fields = subAst.fields.map(f => f.field).join(', ');
  let sql = `SELECT ${fields} FROM ${subAst.sObject}`;
  if (subAst.where) sql += ` WHERE ${rebuildWhere(subAst.where, null)}`;
  return sql;
}

function renderLeaf(node: WhereNode, prefix: string | null): string {
  const open  = '('.repeat(node.openParen  || 0);
  const close = ')'.repeat(node.closeParen || 0);
  const field = prefix ? `${prefix}.${node.field}` : node.field!;

  if (node.literalType === 'SUBQUERY') {
    return `${open}${field} ${node.operator} (${rebuildSubquery(node.valueQuery!)})${close}`;
  }
  if (Array.isArray(node.value)) {
    return `${open}${field} ${node.operator} (${node.value.join(', ')})${close}`;
  }
  return `${open}${field} ${node.operator} ${node.value}${close}`;
}

function rebuildWhere(node: WhereNode | null | undefined, prefix: string | null): string {
  if (!node) return '';
  if (node.field) return renderLeaf(node, prefix);

  const left  = rebuildWhere(node.left,  prefix);
  const right = node.right ? rebuildWhere(node.right, prefix) : '';
  if (!right) return left;
  return `${left} ${node.operator} ${right}`;
}

export function transformWhere(whereClause: string, relPath: string): string {
  const normalized = whereClause.trim().replace(/^WHERE\s+/i, '');
  const ast = parseQuery(`SELECT Id FROM X WHERE ${normalized}`);
  if (!ast.where) return normalized;
  return rebuildWhere(ast.where as unknown as WhereNode, relPath);
}

// ── Dot-notation WHERE builder ────────────────────────────────────────────────
// Combines a node's own WHERE conditions with each ancestor's conditions,
// prefixing ancestor fields with the relationship traversal path so the
// result is a single flat WHERE clause for the current object's SObject.
//
// Example (Case with parent Contact and grandparent Account):
//   own:        Status = 'Open'
//   Contact:    Contact.Email LIKE '%acme%'
//   Account:    Contact.Account.Name = 'Acme'
//   → "(Status = 'Open') AND (Contact.Email LIKE '%acme%') AND (Contact.Account.Name = 'Acme')"

export function buildDotNotationWhere(
  node: Pick<ISalesforceObject, 'condition' | 'field' | 'fieldApiName'>,
  ancestors: Pick<ISalesforceObject, 'condition' | 'field' | 'fieldApiName'>[]
): string | null {
  const parts: string[] = [];

  const ownWhere = buildOwnWhereBody(node);
  if (ownWhere) { parts.push(`(${ownWhere})`); }

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestorWhere = buildOwnWhereBody(ancestors[i]);
    if (!ancestorWhere) { continue; }
    const relPath = getRelPathToAncestor(node, ancestors, i);
    parts.push(`(${transformWhere(ancestorWhere, relPath)})`);
  }

  return parts.length > 0 ? parts.join(' AND ') : null;
}
