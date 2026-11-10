import { httpRequest } from '../../../utils/http-request';
import { CORE_SERVICE, INTERNAL_SECRET, SALESFORCE_BULK_API_VERSION } from '../../../constant';
import { logger } from '../../../middlewares/logger';
import {
  awaitTokenGate,
  onUnauthorized,
  SalesforceTokenUnavailableError,
  SalesforceTokens,
  TOKEN_GATE_CLOSE_REASON,
} from './token-gate';

const SF_API_VERSION = SALESFORCE_BULK_API_VERSION;

// Wraps every Salesforce API call with the job's TokenGate (token-gate.ts):
// waits while a refresh is running, and on 401 waits for the shared refresh
// and replays the call once. `tokens` is mutated in place, so every caller
// sharing the holder — later pages, exportWithRetry attempts — uses the new
// access token. Bodies must be strings/Buffers so the replay can resend them.
interface SalesforceRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

const isUnauthorized = (error: any) => error?.message?.startsWith('HTTP Error 401');

// A 401 on the replay means Salesforce rejects even a freshly issued token —
// not something another refresh will fix.
const rejectedAfterRefresh = () =>
  new SalesforceTokenUnavailableError(TOKEN_GATE_CLOSE_REASON.reauthRequired, 'rejected after refresh');

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

  await awaitTokenGate(tokens);
  const usedToken = tokens.accessToken;
  try {
    return await makeCall(usedToken);
  } catch (error: any) {
    if (!isUnauthorized(error)) {
      throw error;
    }
  }

  const freshToken = await onUnauthorized(tokens, usedToken);
  try {
    return await makeCall(freshToken);
  } catch (error: any) {
    throw isUnauthorized(error) ? rejectedAfterRefresh() : error;
  }
};

// Raw-response variant for callers that need the Response itself (CSV pages,
// SOAP). Same gate and single replay as salesforceRequest; `init` must be
// replayable (string/Buffer body).
const salesforceFetch = async (
  url: string,
  init: RequestInit,
  tokens: SalesforceTokens
): Promise<Response> => {
  const send = (accessToken: string) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${accessToken}`,
      },
    });

  await awaitTokenGate(tokens);
  const usedToken = tokens.accessToken;
  const response = await send(usedToken);
  if (response.status !== 401) {
    return response;
  }

  const replay = await send(await onUnauthorized(tokens, usedToken));
  if (replay.status === 401) {
    throw rejectedAfterRefresh();
  }
  return replay;
};

// ---------------------------------------------------------------------------
// Returns a page-fetcher bound to the given token holder. Result-page
// downloads replay from the same locator after a refresh.
// ---------------------------------------------------------------------------
const makePageFetcher =
  (tokens: SalesforceTokens) =>
  (url: string): Promise<Response> =>
    salesforceFetch(url, { headers: { Accept: 'text/csv' } }, tokens);

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
export type { SalesforceTokens };
