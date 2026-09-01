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

function getMaxRelationshipDepth(whereBody: string): number {
  try {
    const ast = parseQuery(`SELECT Id FROM X WHERE ${whereBody}`);
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

export const validateSoqlSyntax = (soql: string): IValidateSoqlResult => {
  try {
    parseQuery(soql);
  } catch (error: any) {
    return { isValid: false, error: `Invalid SOQL syntax: ${error?.message ?? 'parse error'}` };
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
