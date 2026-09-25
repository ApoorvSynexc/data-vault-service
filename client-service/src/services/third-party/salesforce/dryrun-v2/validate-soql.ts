import { parseQuery } from '@jetstreamapp/soql-parser-js';
import { IUser } from '../../../../models';
import { salesforceRequest } from '..';
import { resolveSalesforceTokens } from './salesforce-api';

const SF_API_VERSION = 'v66.0';
const MAX_RELATIONSHIP_DEPTH = 4;

// ── Relationship depth analysis ───────────────────────────────────────────────
// Cast from the soql-parser-js library's WhereClause type via
// `as unknown as WhereNode` (mirrors the same pattern the now-retired
// dry-run (v1) module used).
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

// Returns the maximum number of relationship traversals (dots) across all
// field references in a WHERE clause body.
// e.g. "Owner.Profile.Name = 'Admin'"              → 2
//      "Contact.Account.Owner.Profile.Name = 'X'"  → 4
function walkMaxDepth(node: WhereNode | null | undefined): number {
  if (!node) { return 0; }
  if (node.field) { return (node.field.match(/\./g) ?? []).length; }
  return Math.max(walkMaxDepth(node.left), walkMaxDepth(node.right));
}

// soql-parser-js doesn't understand Salesforce's bare (unquoted) Time literal
// syntax (HH:mm:ss[.SSS][Z|±hh:mm]) — it misparses the colons and throws an
// unrelated, confusing error ("Mismatched parentheses..." / "Unexpected
// token :"), even though this is valid SOQL that Salesforce's own
// query?explain= accepts without issue. Swapped for a syntactically-neutral
// placeholder for this LOCAL structural pre-check only (parse succeeds, no
// value/field details from the result are used past parens/relationship
// depth) — the real, unmodified soql is still what's sent to Salesforce.
const BARE_TIME_LITERAL_RE = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const forLocalSyntaxCheck = (soql: string): string => soql.replace(BARE_TIME_LITERAL_RE, '0');

function getMaxRelationshipDepth(whereBody: string): number {
  try {
    const ast = parseQuery(`SELECT Id FROM X WHERE ${forLocalSyntaxCheck(whereBody)}`);
    return walkMaxDepth(ast.where as unknown as WhereNode);
  } catch {
    return 0;
  }
}

export interface IValidateSoqlResult {
  isValid: boolean;
  error?: string;
  errorCode?: string;
  relationshipDepth?: number;
}

// Safety net behind assertNoTopLevelClauses/assertNoSubqueries/assertNoFunctionCalls
// (soql-generation.ts) — those name the SPECIFIC clause a condition used, but
// their keyword list can't cover every clause Salesforce supports. A clause
// they don't yet know about reaches this parser instead, and because the app
// wraps the condition in its own `AND (...)` before parsing, a clause the
// parser correctly recognizes as valid (e.g. WITH SYSTEM_MODE, FOR VIEW) makes
// its WHERE-expression loop stop consuming before that closing paren, so the
// error always comes out shaped as one of these two library-internal messages
// — never anything more specific. Translated here so an unlisted clause still
// reads as a real validation message instead of parser-library internals.
const RAW_PARSER_LEAK_RE = /mismatched parentheses|expected identifier but found/i;

export const validateSoqlSyntax = (soql: string): IValidateSoqlResult => {
  try {
    parseQuery(forLocalSyntaxCheck(soql));
  } catch (error: any) {
    const rawMessage = error?.message ?? 'parse error';
    const friendly = RAW_PARSER_LEAK_RE.test(rawMessage)
      ? 'This condition uses SOQL syntax that is not supported in a filter condition (e.g. an unsupported clause like GROUP BY, LIMIT, ORDER BY, USING SCOPE, or a subquery), or contains a syntax error. Please check your condition and try again.'
      : rawMessage;
    return { isValid: false, error: `Invalid SOQL syntax: ${friendly}` };
  }

  const whereBody = soql.match(/\bWHERE\b([\s\S]*)/i)?.[1]?.trim();
  const relationshipDepth = whereBody ? getMaxRelationshipDepth(whereBody) : 0;

  if (relationshipDepth > MAX_RELATIONSHIP_DEPTH) {
    return {
      isValid: false,
      relationshipDepth,
      error: `Query uses ${relationshipDepth} levels of relationship traversal. Maximum allowed is ${MAX_RELATIONSHIP_DEPTH}.`,
    };
  }

  return { isValid: true, relationshipDepth };
};

const parseExplainError = (error: any): { errorCode?: string; message?: string } | null => {
  try {
    const json = String(error?.message ?? '').replace(/^HTTP Error \d+:\s*/, '');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch {
    return null;
  }
};

export const validateSoql = async (params: { user: IUser; soql: string }): Promise<IValidateSoqlResult> => {
  const { user, soql } = params;

  const syntaxResult = validateSoqlSyntax(soql);
  if (!syntaxResult.isValid) {
    return syntaxResult;
  }

  const { instanceUrl, tokens } = await resolveSalesforceTokens(user);

  try {
    await salesforceRequest(
      {
        url: `${instanceUrl}/services/data/${SF_API_VERSION}/query?explain=${encodeURIComponent(soql)}`,
        method: 'GET',
      },
      tokens
    );
    return { isValid: true, relationshipDepth: syntaxResult.relationshipDepth };
  } catch (error: any) {
    const parsed = parseExplainError(error);
    return {
      isValid: false,
      relationshipDepth: syntaxResult.relationshipDepth,
      error: parsed?.message ?? error?.message ?? 'Salesforce rejected the query',
      ...(parsed?.errorCode && { errorCode: parsed.errorCode }),
    };
  }
};
