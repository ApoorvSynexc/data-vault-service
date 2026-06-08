import { getCrmById, getCrmTokens } from '../../../crm';
import type { SalesforceTokens } from '../index';
import { SalesforceClient } from './sf-client';
import { executeDryRun } from './executor';
import type { IDryRunPayload, IDryRunResult } from './types';

export type { IDryRunPayload, IDryRunResult, IDryRunObjectResult, IValidateSoqlPayload, IValidateSoqlItem } from './types';

/**
 * Entry point for a dry-run record count.
 *
 * Resolves the CRM credentials from DynamoDB, builds a SalesforceClient,
 * and delegates to the execution engine, which:
 *   1. Converts the payload tree into a DAG
 *   2. Processes objects in topological order (parents before children)
 *   3. Returns a flat map of { objectName: recordCount }
 */
const dryRun = async (payload: IDryRunPayload): Promise<IDryRunResult> => {
  const { crmId } = payload;
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

  const sfClient = new SalesforceClient(instanceUrl, tokens);
  return executeDryRun(payload, sfClient);
};

export { dryRun };
export { validateSoql } from './validate-soql';
