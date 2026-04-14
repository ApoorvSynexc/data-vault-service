import { httpRequest } from '../../../utils/http-request';
import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';

export class SalesforceAuthExpiredError extends Error {
  constructor() {
    super('Salesforce session expired. User must re-authenticate.');
    this.name = 'SalesforceAuthExpiredError';
  }
}

export interface SalesforceTokens {
  accessToken: string;
  refreshToken: string;
  crmId: string;
}

interface SalesforceRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;
  query?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Wraps every Salesforce API call with automatic token refresh on 401.
//
// IMPORTANT: `tokens` is mutated in-place when a refresh occurs so all
// callers sharing the same object automatically use the new access token —
// including subsequent pages in the upload loop and any retry attempts in
// exportWithRetry.
// ---------------------------------------------------------------------------
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

export const refreshSalesforceToken = async (crmId: string): Promise<any> => {
  return httpRequest({
    url: `${CORE_SERVICE}/v1/internal/refresh-token?crmId=${crmId}`,
    method: 'GET',
    headers: {
      'x-internal-secret': INTERNAL_SECRET,
    },
  });
};

export { salesforceRequest };
