import { parseQuery } from '@jetstreamapp/soql-parser-js';
import { getMaxRelationshipDepth } from '../dry-run/soql-builder';
import { IUser } from '../../../../models';
import { salesforceRequest } from '..';
import { resolveSalesforceTokens } from './salesforce-api';

const SF_API_VERSION = 'v66.0';
const MAX_RELATIONSHIP_DEPTH = 4;

export interface IValidateSoqlResult {
  isValid: boolean;
  error?: string;
  errorCode?: string;
  relationshipDepth?: number;
}

// Pure syntax + relationship-depth check — no Salesforce API call. Runs the
// same soql-parser-js parser dry-run/soql-builder.ts already relies on,
// directly against the exact soql string generateSoqlQueries() built (or
// previewRecords' reformatted version of it). Catches malformed WHERE
// clauses (bad quoting, mismatched parens, disallowed tokens, ...) and
// excessive relationship traversal before ever spending a Salesforce API
// call on it.
//
// What this does NOT check: whether the object/fields actually exist or are
// accessible in the org — for that, see validateSoql below.
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

// Salesforce replies to a bad explain (unknown object/field, no access) with
// a 400 body shaped [{ errorCode, message }] — httpRequest surfaces that as
// a thrown "HTTP Error 400: {json}". Unwrap it the same way apex.ts's
const parseExplainError = (error: any): { errorCode?: string; message?: string } | null => {
  try {
    const json = String(error?.message ?? '').replace(/^HTTP Error \d+:\s*/, '');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch {
    return null;
  }
};

// Full validation: the local syntax/depth check above, then whether the
// object and every field referenced in the query actually exist and are
// accessible to this user in the org — via Salesforce's Query Explain
// resource (`?explain=` instead of `?q=`), which validates and plans a
// query WITHOUT executing it or returning any rows. That's the one thing
// the local parser can never know on its own (it has no idea what fields
// exist, let alone what this user is allowed to see), so it costs one real
// Salesforce API call — but no bulk query, no records, no custom Apex
// endpoint.
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
