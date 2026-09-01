import type { ISalesforceObject } from "./types";
import { formatFieldValuesForSOQL, formatSalesforceValueByDataType } from "../../../../utils/helper";

export interface ISoqlCountQuery {
  referenceId: string;
  id: string;
  name: string;
  soql: string;
}

// Ported from backup-service/src/services/third-party/salesforce/schedule/archival-v2
// — same WHERE-building rules, adapted to client-service's ISalesforceObject/
// IFieldFilter shape.
// Client-service's FilterOperator ('=' | '!=' | 'LIKE' | 'IN', see ./types.ts)
// is narrower than archival-v2's — no comparison operators or NOT IN exist on
// this side, so this list (and the branches below) only cover what the type
// actually allows.
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;
const ALLOWED_OPERATORS = new Set(['=', '!=', 'LIKE', 'IN']);
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

const isDateLiteral = (value: string): boolean =>
  DATE_LITERALS.has(value.toUpperCase()) ||
  /^(LAST|NEXT)_N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS):\d+$/i.test(value);

const buildFilterCondition = (f: NonNullable<ISalesforceObject['field']>[number], preformattedValue: string): string => {
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

  if (operator === 'IN') {
    const parts = rawValue.split(',').map((v) => v.trim()).filter(Boolean);
    return `${name} IN (${parts.map((v) => formatSalesforceValueByDataType(v, dataType)).join(', ')})`;
  }

  const ldt = dataType.toLowerCase();
  if ((ldt === 'date' || ldt === 'datetime') && isDateLiteral(rawValue)) {
    return `${name} ${operator} ${rawValue}`;
  }

  return `${name} ${operator} ${preformattedValue}`;
};

const buildWhereClause = (object: ISalesforceObject): string => {
  const { field, condition } = object;
  if (!condition) {
    return '';
  }

  if (condition.type === 'SOQL') {
    const soqlQuery: string = condition.soqlQuery ?? '';
    const body = soqlQuery.trim().replace(/^WHERE\s+/i, '');
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
        formattedFields[idx]?.filter?.value ??
        formatSalesforceValueByDataType(f.filter.value, f.dataType);
      filterMap.set(idx + 1, buildFilterCondition(f, preformattedValue));
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

const fkToRelationshipName = (fieldApiName: string): string => {
  if (fieldApiName.endsWith('__c')) {
    return `${fieldApiName.slice(0, -3)}__r`;
  }
  if (fieldApiName.endsWith('Id')) {
    return fieldApiName.slice(0, -2);
  }
  return fieldApiName;
};

const transformWhereBodyForChild = (whereBody: string, fkFieldName: string): string => {
  if (!whereBody.trim()) {
    return `${fkFieldName} != null`;
  }
  const relName = fkToRelationshipName(fkFieldName);
  return whereBody.replace(
    /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(\s*(?:!=|>=|<=|=|>|<)|\s+(?:NOT\s+IN|IN|LIKE)\s)/gi,
    (_match, field, op) => {
      if (field === 'Id') {
        return `${fkFieldName}${op}`;
      }
      return `${relName}.${field}${op}`;
    }
  );
};

const generateObjectSoql = (
  object: ISalesforceObject,
  ancestorWhereBody: string,
  queries: ISoqlCountQuery[]
): void => {
  const ownWhereClause = buildWhereClause(object);
  const ownWhereBody = ownWhereClause.replace(/^WHERE\s+/i, '').trim();

  let effectiveWhereBody: string;
  if (object.fieldApiName) {
    const propagated = ancestorWhereBody
      ? transformWhereBodyForChild(ancestorWhereBody, object.fieldApiName)
      : `${object.fieldApiName} != null`;
    effectiveWhereBody = ownWhereBody ? `(${propagated}) AND (${ownWhereBody})` : propagated;
  } else {
    effectiveWhereBody = ownWhereBody;
  }

  const soqlWhere = effectiveWhereBody
    ? `WHERE IsDeleted = false AND (${effectiveWhereBody})`
    : 'WHERE IsDeleted = false';

  queries.push({
    referenceId: `n${queries.length}`,
    id: object.id,
    name: object.name,
    soql: `SELECT COUNT() FROM ${object.name} ${soqlWhere}`,
  });

  if (object.children?.length) {
    for (const child of object.children) {
      generateObjectSoql(child, effectiveWhereBody, queries);
    }
  }
};

// Entry point — flattens the whole object tree (root objects + every
// descendant) into one array of COUNT() queries, ready to hand to the
// Composite API in as few calls as possible.
export const generateSoqlQueries = (objects: ISalesforceObject[]): ISoqlCountQuery[] => {
  const queries: ISoqlCountQuery[] = [];
  for (const object of objects) {
    generateObjectSoql(object, '', queries);
  }
  return queries;
};
