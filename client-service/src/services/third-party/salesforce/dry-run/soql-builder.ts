import { parseQuery } from '@jetstreamapp/soql-parser-js';
import { formatSalesforceValueByDataType, formatFieldValuesForSOQL } from '../../../../utils/helper';
import type { ISalesforceObject, IFieldFilter } from './types';

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

function buildFieldCondition(f: IFieldFilter, preformattedValue: string): string {
  const { value, operator } = f.filter;
  const { name, dataType } = f;

  if (operator === 'LIKE') {
    const escaped = String(value).replace(/'/g, "''");
    const wrapped = escaped.includes('%') ? escaped : `%${escaped}%`;
    return `${name} LIKE '${wrapped}'`;
  }

  if (operator === 'IN') {
    const values = String(value).split(',').map(v => v.trim()).filter(Boolean);
    return `${name} IN (${values.map(v => formatSalesforceValueByDataType(v, dataType)).join(', ')})`;
  }

  const ldt = dataType.toLowerCase();
  if ((ldt === 'date' || ldt === 'datetime') && isDateLiteral(value)) {
    return `${name} ${operator} ${value}`;
  }

  return `${name} ${operator} ${preformattedValue}`;
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

  const formattedFields = formatFieldValuesForSOQL(field);
  const conditions = field.map((f, idx) =>
    buildFieldCondition(f, formattedFields[idx]?.filter?.value ?? formatSalesforceValueByDataType(f.filter.value, f.dataType))
  );

  if (condition.type === 'AND') return conditions.join(' AND ');
  if (condition.type === 'OR') return conditions.join(' OR ');
  if (condition.type === 'CUSTOM') {
    return condition.expression.replace(/\d+/g, n => conditions[parseInt(n, 10) - 1] ?? n);
  }

  return null;
}

// ── Child WHERE builder ───────────────────────────────────────────────────────
// Transforms a parent's WHERE body into a child's WHERE body using dot-notation.
// Each field reference is prefixed with parentFieldApiName.
// Special case: 'Id' field → parentFieldApiName alone (FK itself, not FK.Id).
//
// e.g. "Owner.Email != null AND Status = 'Active'", "AccountId"
//    → "AccountId.Owner.Email != null AND AccountId.Status = 'Active'"
//
// e.g. "Id != null AND Owner.Email != null", "AccountId"
//    → "AccountId != null AND AccountId.Owner.Email != null"

function toRelationshipName(fieldApiName: string): string {
  if (!fieldApiName) return '';
  if (fieldApiName.endsWith('__c')) return `${fieldApiName.slice(0, -3)}__r`;
  if (fieldApiName.endsWith('Id')) return fieldApiName.slice(0, -2);
  return fieldApiName;
}

function rebuildSubquery(subAst: NonNullable<WhereNode['valueQuery']>): string {
  const fields = subAst.fields.map(f => f.field).join(', ');
  let sql = `SELECT ${fields} FROM ${subAst.sObject}`;
  if (subAst.where) sql += ` WHERE ${rebuildChildWhere(subAst.where, 'Id', 'Id')}`;
  return sql;
}

// fieldApiName — the actual FK field on the child (e.g. "Test_1__c", "AccountId")
//   used only for the Id special-case: parent "Id = 'x'" → child "Test_1__c = 'x'"
// relName — the relationship traversal name (e.g. "Test_1__r", "Account")
//   used for all other fields: parent "Name = 'Acme'" → child "Test_1__r.Name = 'Acme'"
function renderChildLeaf(node: WhereNode, fieldApiName: string, relName: string): string {
  const open  = '('.repeat(node.openParen  || 0);
  const close = ')'.repeat(node.closeParen || 0);
  const field = node.field === 'Id' ? fieldApiName : `${relName}.${node.field}`;

  if (node.literalType === 'SUBQUERY') {
    return `${open}${field} ${node.operator} (${rebuildSubquery(node.valueQuery!)})${close}`;
  }
  if (Array.isArray(node.value)) {
    return `${open}${field} ${node.operator} (${node.value.join(', ')})${close}`;
  }
  return `${open}${field} ${node.operator} ${node.value}${close}`;
}

function rebuildChildWhere(node: WhereNode | null | undefined, fieldApiName: string, relName: string): string {
  if (!node) { return ''; }
  if (node.field) { return renderChildLeaf(node, fieldApiName, relName); }
  const left  = rebuildChildWhere(node.left,  fieldApiName, relName);
  const right = node.right ? rebuildChildWhere(node.right, fieldApiName, relName) : '';
  if (!right) { return left; }
  return `${left} ${node.operator} ${right}`;
}

export function buildChildWhereBody(parentWhereBody: string, parentFieldApiName: string): string {
  const normalized = parentWhereBody.trim().replace(/^WHERE\s+/i, '');
  const relName = toRelationshipName(parentFieldApiName);
  try {
    const ast = parseQuery(`SELECT Id FROM X WHERE ${normalized}`);
    if (!ast.where) { return `${parentFieldApiName} != null`; }
    return rebuildChildWhere(ast.where as unknown as WhereNode, parentFieldApiName, relName);
  } catch {
    return `${parentFieldApiName} != null`;
  }
}

