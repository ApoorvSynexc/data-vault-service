import type { SalesforceClient } from './sf-client';

/**
 * Fetches all IDs for one object + WHERE clause via the Apex harvest-ids endpoint.
 *
 * The endpoint paginates via cursor (ORDER BY Id ASC, 2 000 records/page).
 * SalesforceClient.harvestAllIds() loops until done=true and returns the full set.
 *
 * @param objectName   Salesforce object API name (e.g. 'Account')
 * @param whereClause  Full WHERE string including the keyword, e.g. "WHERE Name = 'X'"
 *                     or an empty string for no filter
 */
export async function harvestIds(
  objectName: string,
  whereClause: string,
  sfClient: SalesforceClient
): Promise<string[]> {
  const whereBody = whereClause ? whereClause.replace(/^WHERE\s+/i, '').trim() : '';
  return sfClient.harvestAllIds(objectName, whereBody);
}
