import { salesforceRequest } from '../index';
import type { SalesforceTokens } from '../index';
import type { ICountItem, ICountResult } from './types';

const NAMESPACE = 'SYX_DVV';
const PAGE_SIZE = 2000;

// ── Apex endpoint response shapes ─────────────────────────────────────────────

interface ICountBatchResponse {
  success: boolean;
  results: ICountResult[];
}

interface IHarvestResponse {
  success: boolean;
  ids: string[];
  done: boolean;
  nextCursor: string;
}

export interface IValidateSoqlResponse {
  success: boolean;
  isValid: boolean;
  errorMessage?: string;
  errorCode?: string;
}

// ── SalesforceClient ──────────────────────────────────────────────────────────

/**
 * Thin wrapper around the project's `salesforceRequest` helper that targets
 * the Apex endpoints used by the dry-run/validate-soql engine:
 *
 *   POST /services/apexrest/SYX_DVV/v1/data-vault/query-count
 *   POST /services/apexrest/SYX_DVV/v1/data-vault/harvest-ids
 *   POST /services/apexrest/SYX_DVV/v1/data-vault/validate-soql
 *
 * Instantiate once per call with the CRM's resolved instanceUrl and tokens.
 */
export class SalesforceClient {
  private readonly apexBase: string;
  private readonly tokens: SalesforceTokens;

  constructor(instanceUrl: string, tokens: SalesforceTokens) {
    this.apexBase = `${instanceUrl}/services/apexrest/${NAMESPACE}/v1/data-vault`;
    this.tokens   = tokens;
  }

  /**
   * Counts records for up to 20 (key, apiName, whereClause) items in one call.
   */
  async countBatch(items: ICountItem[]): Promise<ICountResult[]> {
    const { data } = await salesforceRequest<ICountBatchResponse>(
      {
        url:    `${this.apexBase}/query-count`,
        method: 'POST',
        body:   JSON.stringify({ items }),
      },
      this.tokens
    );
    console.log(`[countBatch] received response: ${JSON.stringify(data)}`);
    console.log(`ITEMS: ${JSON.stringify(items)}`);
    if (!data.success) {
      throw new Error(`[query-count] request failed: ${JSON.stringify(data)}`);
    }

    return data.results;
  }

  /**
   * Harvests ALL IDs for one object + WHERE body via cursor pagination.
   * Loops until the Apex endpoint signals done=true (2 000 records per page).
   *
   * @param objectName  Salesforce object API name
   * @param whereBody   WHERE clause body WITHOUT the "WHERE" keyword, or ''
   */
  async harvestAllIds(objectName: string, whereBody: string): Promise<string[]> {
    const allIds: string[] = [];
    let cursor = '';

    for (;;) {
      const { data } = await salesforceRequest<IHarvestResponse>(
        {
          url:    `${this.apexBase}/harvest-ids`,
          method: 'POST',
          body:   JSON.stringify({
            apiName:     objectName,
            whereClause: whereBody,
            cursor,
            pageSize:    PAGE_SIZE,
          }),
        },
        this.tokens
      );

      if (!data.success) {
        throw new Error(`[harvest-ids] failed for ${objectName}: ${JSON.stringify(data)}`);
      }

      allIds.push(...(data.ids ?? []));
      if (data.done) break;
      cursor = data.nextCursor;
    }

    return allIds;
  }

  /**
   * Validates a SOQL WHERE clause for a given object via the Apex endpoint.
   *
   * @param apiName        Salesforce object API name (e.g. 'Account')
   * @param whereClause    WHERE body WITHOUT the "WHERE" keyword, or ''
   * @param checkExecution Whether to also attempt query execution (default false)
   */
  async validateSoqlQuery(
    apiName: string,
    whereClause: string,
    checkExecution = false
  ): Promise<IValidateSoqlResponse> {
    const { data } = await salesforceRequest<IValidateSoqlResponse>(
      {
        url:    `${this.apexBase}/validate-soql`,
        method: 'POST',
        body:   JSON.stringify({ apiName, whereClause, checkExecution }),
      },
      this.tokens
    );
    return data;
  }
}
