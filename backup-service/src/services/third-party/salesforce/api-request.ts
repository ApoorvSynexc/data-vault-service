import { httpRequest } from '../../../utils/http-request';
import { SALESFORCE_BULK_API_VERSION } from '../../../constant';
import {
  awaitTokenGate,
  onUnauthorized,
  SalesforceAuthExpiredError,
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
  new SalesforceAuthExpiredError(TOKEN_GATE_CLOSE_REASON.reauthRequired, 'rejected after refresh');

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

export {
  salesforceRequest,
  salesforceFetch,
  makePageFetcher,
  createBulkQueryJob,
  SalesforceAuthExpiredError,
};
export type { SalesforceTokens };
