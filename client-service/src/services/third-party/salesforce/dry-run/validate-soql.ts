import { parseQuery } from '@jetstreamapp/soql-parser-js';
import { apexValidateSoql } from '../apex';
import { buildOwnWhereBody, getMaxRelationshipDepth } from './soql-builder';
import type { IValidateSoqlPayload, IValidateSoqlItem } from './types';

export async function validateSoql(payload: IValidateSoqlPayload): Promise<IValidateSoqlItem> {
  const { user, object, isParent } = payload;
  const whereClause = buildOwnWhereBody(object);

  // Children cannot have any filter conditions
  if (!isParent) {
    if (whereClause) {
      return {
        whereClause,
        isValid: false,
        error: 'Child objects cannot have filter conditions.',
      };
    }
    return { whereClause: null, isValid: true };
  }

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

  // ── Apex validation ───────────────────────────────────────────────────────

  const response = await apexValidateSoql(user, object.name, whereClause);

  if (!response.isValid) {
    return {
      whereClause,
      isValid: false,
      error: response.message ?? `Salesforce error: ${response.errorCode ?? 'unknown'}`,
    };
  }

  const depth = getMaxRelationshipDepth(whereClause);

  if (depth > 4) {
    return {
      whereClause,
      isValid: false,
      error: `Query uses ${depth} levels of relationship traversal. Maximum allowed is 4.`,
    };
  }

  return { whereClause, isValid: true, relationshipDepth: depth };
}
