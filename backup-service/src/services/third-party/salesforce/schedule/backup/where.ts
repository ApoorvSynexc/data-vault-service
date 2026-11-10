import { IBackupObject } from '../../../../../models';

// SOQL injection guards.
// Field names:  standard Salesforce API name (e.g. "Account", "Owner.Name")
// Operators:    must be one of the Joi-validated enum values
// Values:       allow the character set needed for SOQL literals (quoted
//               strings, numbers, dates, booleans, IN lists, the
//               semicolon-joined value INCLUDES/EXCLUDES need for a
//               Multi-Select Picklist, and a leading currency symbol —
//               stripped by buildFilterCondition's numeric sanitization
//               below, not left in the emitted SOQL) while blocking SQL/SOQL
//               meta-characters like ` -- /* */ that have no legitimate use
//               in a filter value
// Expression:   CUSTOM expressions must only contain index numbers,
//               whitespace, parentheses, and the keywords AND / OR / NOT
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/;
const SAFE_VALUE_RE = /^[\w\s.'@%(),:.+;$-]+$/;
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

const buildFilterCondition = (name: string, operator: string, value: string): string => {
  if (!SAFE_FIELD_NAME_RE.test(name)) {
    throw new Error(`Invalid SOQL field name: "${name}"`);
  }
  if (!ALLOWED_OPERATORS.has(operator)) {
    throw new Error(`Disallowed SOQL operator: "${operator}"`);
  }
  if (!SAFE_VALUE_RE.test(value)) {
    throw new Error(`Invalid SOQL filter value: "${value}"`);
  }

  // Multi-Select Picklist membership test: Salesforce's own syntax is a
  // SINGLE quoted string with the candidate values semicolon-joined inside
  // it — Field INCLUDES ('A;B') — not a parenthesized list the way IN's
  // values are. The raw value arrives comma-separated, same convention every
  // other multi-value filter here uses; only the wire format changes.
  if (operator === 'INCLUDES' || operator === 'EXCLUDES') {
    const parts = value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const joined = parts.map((v) => v.replace(/'/g, "''")).join(';');
    return `${name} ${operator} ('${joined}')`;
  }

  // If value is not already quoted and not a number/boolean, wrap it in single quotes.
  // A Currency field's UI input is the one numeric type likely to arrive
  // formatted (e.g. "$1,234.56") — Number() rejects that outright, which used
  // to fall through to being quoted as a STRING against a numeric field
  // ("Field = '1,234.56'"), a type mismatch Salesforce rejects. Strip
  // currency-symbol/thousands-separator cruft and re-test before giving up on
  // it being numeric.
  let formattedValue = value;
  if (!value.startsWith("'") && !value.startsWith('(') && value !== 'true' && value !== 'false') {
    if (!isNaN(Number(value))) {
      // already a clean numeric literal — unchanged
    } else {
      const sanitized = value.trim().replace(/[^0-9.-]/g, '');
      formattedValue = sanitized && !isNaN(Number(sanitized)) ? sanitized : `'${value}'`;
    }
  }

  return `${name} ${operator} ${formattedValue}`;
};

// Build a SOQL WHERE clause from an object's field filters + condition.
// Fields are 1-indexed (field[0] -> "1", field[1] -> "2", ...).
// Only fields that have a filter contribute to the WHERE clause.
// AND/OR  -> join all filter conditions with the given logical operator.
// CUSTOM  -> replace 1-based indexes in condition.expression with the
//            corresponding filter condition strings.
export const buildWhereClause = (object: IBackupObject): string => {
  const { field, condition } = object;
  if (!field?.length || !condition) {
    return '';
  }

  const filterMap = new Map<number, string>();
  field.forEach((f, idx) => {
    if (f.filter) {
      filterMap.set(idx + 1, buildFilterCondition(f.name, f.filter.operator, f.filter.value));
    }
  });

  if (filterMap.size === 0) {
    return '';
  }

  if (condition.type === 'CUSTOM' && condition.expression) {
    // Strip recognized keywords then reject anything other than digits,
    // spaces, and parentheses — prevents injecting arbitrary SOQL clauses
    // via the expression string itself.
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
