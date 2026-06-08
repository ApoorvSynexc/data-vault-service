import { parseQuery } from '@jetstreamapp/soql-parser-js';
import { getCrmById, getCrmTokens } from '../../../crm';
import type { SalesforceTokens } from '../index';
import { SalesforceClient } from './sf-client';
import { buildOwnWhereBody } from './soql-builder';
import type { IValidateSoqlPayload, IValidateSoqlItem } from './types';

// ── Internal AST node shape ───────────────────────────────────────────────────

interface WhereNode {
  field?: string;
  operator?: string;
  value?: string | string[];
  literalType?: string;
  openParen?: number;
  closeParen?: number;
  left?: WhereNode;
  right?: WhereNode;
}

// ── AST analysis ──────────────────────────────────────────────────────────────

interface IAnalysis {
  dotNotationFound: boolean;
  inCount: number;
}

function _walkWhere(node: WhereNode, ctx: IAnalysis): void {
  if (node.field) {
    if (node.field.includes('.')) ctx.dotNotationFound = true;
    const op = (node.operator ?? '').toUpperCase();
    if (op === 'IN' || op === 'NOT IN') ctx.inCount++;
    return;
  }
  if (node.left) _walkWhere(node.left, ctx);
  if (node.right) _walkWhere(node.right, ctx);
}

function _analyzeWhere(whereBody: string): IAnalysis {
  const ctx: IAnalysis = { dotNotationFound: false, inCount: 0 };
  const ast = parseQuery(`SELECT Id FROM X WHERE ${whereBody}`);
  if (ast.where) _walkWhere(ast.where as unknown as WhereNode, ctx);
  return ctx;
}

// ── Core service ──────────────────────────────────────────────────────────────

export async function validateSoql(payload: IValidateSoqlPayload): Promise<IValidateSoqlItem> {
  const { crmId, object, isParent } = payload;
  const whereClause = buildOwnWhereBody(object);

  if (!whereClause) {
    return { whereClause: null, isValid: true };
  }

  // ── Syntax check ──────────────────────────────────────────────────────────

  try {
    parseQuery(`SELECT Id FROM X WHERE ${whereClause}`);
  } catch (e: any) {
    return {
      whereClause,
      isValid: false,
      error: `Invalid SOQL syntax: ${e?.message ?? 'parse error'}`,
    };
  }

  // ── Structural safety checks ──────────────────────────────────────────────

  const { dotNotationFound, inCount } = _analyzeWhere(whereClause);

  if (dotNotationFound) {
    return {
      whereClause,
      isValid: false,
      error: 'Cross-object dot notation (e.g. Account.Name) is not allowed in filter conditions.',
    };
  }

  if (!isParent && inCount > 0) {
    return {
      whereClause,
      isValid: false,
      error: 'IN / NOT IN operators are not allowed on child objects.',
    };
  }

  if (isParent && inCount > 2) {
    return {
      whereClause,
      isValid: false,
      error: `Too many IN / NOT IN operators: found ${inCount}, maximum allowed is 2.`,
    };
  }

  // ── Apex validation ───────────────────────────────────────────────────────

  const crm = await getCrmById(crmId);
  if (!crm) throw new Error('CRM not found');

  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) throw new Error('Instance URL not found');

  const { access_token, refresh_token } = getCrmTokens(crm);

  const tokens: SalesforceTokens = {
    accessToken:  access_token,
    refreshToken: refresh_token,
    crmId,
    userId:      crm.userId,
    environment: crm.environment,
    customUrl:   crm.customUrl,
  };

  const sfClient  = new SalesforceClient(instanceUrl, tokens);
  const response  = await sfClient.validateSoqlQuery(object.name, whereClause);

  if (response.isValid) {
    return { whereClause, isValid: true };
  }

  return {
    whereClause,
    isValid: false,
    error: response.errorMessage ?? `Salesforce error: ${response.errorCode ?? 'unknown'}`,
  };
}
