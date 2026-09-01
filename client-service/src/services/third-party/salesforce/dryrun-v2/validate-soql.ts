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
