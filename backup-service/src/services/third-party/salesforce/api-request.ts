import { httpRequest } from '../../../utils/http-request';
import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';

const SF_API_VERSION = 'v65.0';

class SalesforceAuthExpiredError extends Error {
  constructor() {
    super('Salesforce session expired. User must re-authenticate.');
    this.name = 'SalesforceAuthExpiredError';
  }
}

const refreshSalesforceToken = async (crmId: string): Promise<any> => {
  return httpRequest({
    url: `${CORE_SERVICE}/v1/internal/refresh-token?crmId=${crmId}`,
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
}

export interface SalesforceTokens {
  accessToken: string;
  refreshToken: string;
  crmId: string;
}

const salesforceRequest = async <T = any>(
  options: SalesforceRequestOptions,
  tokens: SalesforceTokens
): Promise<T> => {
  const makeCall = (accessToken: string) =>
    httpRequest<T>({
      ...options,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  try {
    return await makeCall(tokens.accessToken);
  } catch (error: any) {
    if (!error?.message?.startsWith('HTTP Error 401')) {
      throw error;
    }

    // Access token expired — refresh and retry once
    try {
      const refreshed = await refreshSalesforceToken(tokens.crmId);
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
        const refreshed = await refreshSalesforceToken(tokens.crmId);
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

// Single call returning both field names (for SOQL) and full schema (for
// schema comparison / upload). Replaces the former getObjectFields +
// getObjectSchema pair that hit the same endpoint twice per object per job.
//
// `mode` is required — the Apex layer defaults missing mode to "archival"
// and then rejects non-deletable objects. Callers must declare their flow
// explicitly: schedule (bulk backup), realtime (event-driven backup), or
// archival (backup + hard-delete).
type ApexMode = 'schedule' | 'realtime' | 'archival';

const getObjectMetadata = async (
  crmId: string,
  objectName: string,
  mode: ApexMode
): Promise<{ fieldNames: string[]; schema: any[] }> => {
  const params = new URLSearchParams({ crmId, objectName, mode });
  const res = await httpRequest({
    url: `${CORE_SERVICE}/v1/internal/fields?${params.toString()}`,
    headers: { 'x-internal-secret': INTERNAL_SECRET },
  });
  const fields: any[] = res?.data?.fields ?? [];
  return {
    fieldNames: fields.map((f) => f.apiName),
    schema: fields,
  };
};

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

export { salesforceRequest, makePageFetcher, getObjectMetadata, createBulkQueryJob };
