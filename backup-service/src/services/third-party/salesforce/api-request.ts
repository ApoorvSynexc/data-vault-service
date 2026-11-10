import { httpRequest } from '../../../utils/http-request';
import { CORE_SERVICE, INTERNAL_SECRET, SALESFORCE_BULK_API_VERSION } from '../../../constant';
import { logger } from '../../../middlewares/logger';

const SF_API_VERSION = SALESFORCE_BULK_API_VERSION;

class SalesforceAuthExpiredError extends Error {
  constructor() {
    super('Salesforce session expired. User must re-authenticate.');
    this.name = 'SalesforceAuthExpiredError';
  }
}

const refreshSalesforceToken = async (backupConfigId: string): Promise<any> => {
  return httpRequest({
    url: `${CORE_SERVICE}/v1/internal/refresh-token?backupConfigId=${backupConfigId}`,
    method: 'GET',
    headers: {
      'x-internal-secret': INTERNAL_SECRET,
    },
  });
};

// Wraps every Salesforce API call with automatic token refresh on 401.
// IMPORTANT: `tokens` is mutated in-place when a refresh occurs so all
// callers sharing the same object automatically use the new access token —
// including subsequent pages in the upload loop and any retry attempts in
// exportWithRetry.
interface SalesforceRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

export interface SalesforceTokens {
  accessToken: string;
  refreshToken: string;
  crmId: string;
  backupConfigId: string;
}

const salesforceRequest = async <T = any>(
  options: SalesforceRequestOptions,
  tokens: SalesforceTokens
): Promise<T> => {
  const makeCall = (accessToken: string) => {
    const { headers, ...opt } = options;
    return httpRequest<T>({
      ...opt,
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
    });
  };

  try {
    return await makeCall(tokens.accessToken);
  } catch (error: any) {
    if (!error?.message?.startsWith('HTTP Error 401')) {
      throw error;
    }

    // Access token expired — refresh and retry once
    try {
      const refreshed = await refreshSalesforceToken(tokens.backupConfigId);
      tokens.accessToken = refreshed.access_token; // mutate shared ref
    } catch {
      throw new SalesforceAuthExpiredError();
    }

    return await makeCall(tokens.accessToken);
  }
};

// ---------------------------------------------------------------------------
// Returns a page-fetcher bound to the given token holder.
// Handles 401 → token refresh → single retry transparently.
// Mutates tokens.accessToken in-place so all callers sharing the same object
// automatically use the refreshed token on subsequent calls.
// ---------------------------------------------------------------------------
const makePageFetcher =
  (tokens: SalesforceTokens) =>
  async (url: string): Promise<Response> => {
    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'text/csv' },
    });
    if (response.status === 401) {
      try {
        const refreshed = await refreshSalesforceToken(tokens.backupConfigId);
        tokens.accessToken = refreshed.access_token;
      } catch {
        throw new SalesforceAuthExpiredError();
      }
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'text/csv' },
      });
    }
    return response;
  };

export interface ISalesforceChild {
  apiName?: string;
  relationshipType?: string; // MASTER | LOOKUP | REQUIRED_LOOKUP
  isRequired?: boolean;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Bulk API 2.0 — create
// ---------------------------------------------------------------------------
interface ICreateBulkQueryJob {
  instanceUrl: string;
  tokens: SalesforceTokens;
  soql: string;
  operation?: 'queryAll' | 'query';
}

const createBulkQueryJob = async (payload: ICreateBulkQueryJob): Promise<string> => {
  const { instanceUrl, tokens, soql, operation = 'query' } = payload;
  const res = await salesforceRequest<{ id: string }>(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query`,
      method: 'POST',
      body: JSON.stringify({ operation, query: soql }),
    },
    tokens
  );

  return res.id;
};

// ---------------------------------------------------------------------------
// Bulk API 2.0 — job state lookup. Returns null when Salesforce no longer knows
// the job (404: expired or deleted), so a caller holding a saved job id can tell
// "resume this job" from "create a new one".
// ---------------------------------------------------------------------------
interface IBulkQueryJobState {
  state: string; // Open | UploadComplete | InProgress | JobComplete | Aborted | Failed
  numberRecordsProcessed?: number;
  errorMessage?: string;
}

interface IBulkQueryJobRef {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
}

const getBulkQueryJobState = async (
  payload: IBulkQueryJobRef
): Promise<IBulkQueryJobState | null> => {
  const { instanceUrl, tokens, jobId } = payload;
  try {
    return await salesforceRequest<IBulkQueryJobState>(
      { url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}` },
      tokens
    );
  } catch (err: any) {
    if (String(err?.message ?? '').startsWith('HTTP Error 404')) {
      return null;
    }
    throw err;
  }
};

// Best effort: a job we are about to abandon should stop consuming Salesforce capacity.
const abortBulkQueryJob = async (payload: IBulkQueryJobRef): Promise<void> => {
  const { instanceUrl, tokens, jobId } = payload;
  try {
    await salesforceRequest(
      {
        url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}`,
        method: 'PATCH',
        body: JSON.stringify({ state: 'Aborted' }),
      },
      tokens
    );
  } catch (err: any) {
    logger.warn(`[range] could not abort Salesforce bulk job ${jobId}: ${err?.message ?? err}`);
  }
};

// ---------------------------------------------------------------------------
// Record count, used only to decide whether an object is large enough to export in
// ranges. Never required for correctness, so any failure returns null.
//  - no filter: GET /limits/recordCount (fast, approximate, ignores WHERE)
//  - filter:    SELECT COUNT() with the same WHERE
// ---------------------------------------------------------------------------
const getRecordCount = async (payload: {
  instanceUrl: string;
  tokens: SalesforceTokens;
  objectName: string;
  whereClause?: string; // empty, or starting with "WHERE "
}): Promise<number | null> => {
  const { instanceUrl, tokens, objectName, whereClause } = payload;
  try {
    if (!whereClause) {
      const res = await salesforceRequest<{ sObjects?: Array<{ name: string; count: number }> }>(
        {
          url: `${instanceUrl}/services/data/${SF_API_VERSION}/limits/recordCount`,
          query: { sObjects: objectName },
        },
        tokens
      );
      const found = res?.sObjects?.find((o) => o.name.toLowerCase() === objectName.toLowerCase());
      if (typeof found?.count === 'number') {
        return found.count;
      }
    }
    const soql = `SELECT COUNT() FROM ${objectName}${whereClause ? ` ${whereClause}` : ''}`;
    const res = await salesforceRequest<{ totalSize?: number }>(
      {
        url: `${instanceUrl}/services/data/${SF_API_VERSION}/query`,
        query: { q: soql },
      },
      tokens
    );
    return typeof res?.totalSize === 'number' ? res.totalSize : null;
  } catch (err: any) {
    logger.warn(`[range] record count unavailable for ${objectName}: ${err?.message ?? err}`);
    return null;
  }
};

export {
  salesforceRequest,
  makePageFetcher,
  createBulkQueryJob,
  getBulkQueryJobState,
  abortBulkQueryJob,
  getRecordCount,
};
export type { IBulkQueryJobState };
