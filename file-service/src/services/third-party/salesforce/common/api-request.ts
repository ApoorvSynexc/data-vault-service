import { httpRequest } from '../../../../utils/http-request';
import {
  awaitTokenGate,
  onUnauthorized,
  SalesforceTokenUnavailableError,
  SalesforceTokens,
  TOKEN_GATE_CLOSE_REASON,
} from './token-gate';

// Wraps every Salesforce API call with the job's TokenGate (token-gate.ts):
// waits while a refresh is running, and on 401 waits for the shared refresh
// and replays the call once. `tokens` is mutated in place, so every caller
// sharing the holder uses the new access token. Bodies must be strings/Buffers
// so the replay can resend them.
interface SalesforceRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

const isUnauthorized = (error: any): boolean => error?.message?.startsWith('HTTP Error 401');

// A 401 on the replay means Salesforce rejects even a freshly issued token —
// not something another refresh will fix.
const rejectedAfterRefresh = (): SalesforceTokenUnavailableError =>
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

export { salesforceRequest, SalesforceTokenUnavailableError };
export type { SalesforceRequestOptions, SalesforceTokens };
