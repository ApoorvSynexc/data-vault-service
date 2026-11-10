import { TOKEN_ERROR_KIND } from '../../../constant';

type TokenErrorKind = (typeof TOKEN_ERROR_KIND)[keyof typeof TOKEN_ERROR_KIND];

interface ClassifiedTokenError {
  kind: TokenErrorKind;
  httpStatus: number | null;
  sfError?: string;
  sfErrorDescription?: string;
  // No HTTP response at all (timeout / reset / DNS) — Salesforce may or may
  // not have rotated the token, so a later invalid_grant is treated cautiously.
  lostResponse: boolean;
}

const EXPIRE_DESCRIPTIONS = [
  'expired access/refresh token',
  'authentication failure',
  'inactive user',
  "user hasn't approved this consumer",
  'activation secret',
];

// invalid_grant descriptions that mean "try again", not "token is dead" —
// e.g. Salesforce is still processing a concurrent request for this token.
const RETRY_GRANT_DESCRIPTIONS = ['already being processed'];

const parseOAuthBody = (body?: string): { error?: string; error_description?: string } => {
  if (!body) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
};

// Maps a failed grant_type=refresh_token call to a Kind. Order matters —
// see the design doc §6. Unknown shapes default to RETRY, never to a silent
// disconnect.
const classifyTokenError = (error: unknown): ClassifiedTokenError => {
  const err = error as { status?: number; body?: string; message?: string };
  const httpStatus = typeof err?.status === 'number' ? err.status : null;

  if (httpStatus === null) {
    return {
      kind: TOKEN_ERROR_KIND.retry,
      httpStatus,
      lostResponse: true,
      sfErrorDescription: err?.message,
    };
  }

  const { error: sfError, error_description: sfErrorDescription } = parseOAuthBody(err.body);
  const base = { httpStatus, sfError, sfErrorDescription, lostResponse: false };
  const description = (sfErrorDescription ?? '').toLowerCase();

  if (httpStatus >= 500 || httpStatus === 429) {
    return { ...base, kind: TOKEN_ERROR_KIND.retry };
  }
  if (sfError === 'invalid_client_id' || sfError === 'invalid_client') {
    return { ...base, kind: TOKEN_ERROR_KIND.platform };
  }
  // unknown_error is retried whatever its description: the default below is
  // RETRY too, and five failed durable retries still end in
  // EXPIRE_UNCONFIRMED, so a persistent one cannot retry forever.
  if (sfError === 'unknown_error') {
    return { ...base, kind: TOKEN_ERROR_KIND.retry };
  }

  if (sfError === 'invalid_grant') {
    if (RETRY_GRANT_DESCRIPTIONS.some((d) => description.includes(d))) {
      return { ...base, kind: TOKEN_ERROR_KIND.retry };
    }
    if (description.includes('inactive organization')) {
      return { ...base, kind: TOKEN_ERROR_KIND.expireSupport };
    }
    if (description.includes('ip restricted')) {
      return { ...base, kind: TOKEN_ERROR_KIND.ipRestricted };
    }
    if (EXPIRE_DESCRIPTIONS.some((d) => description.includes(d))) {
      return { ...base, kind: TOKEN_ERROR_KIND.expire };
    }
    return { ...base, kind: TOKEN_ERROR_KIND.expireUnconfirmed };
  }

  return { ...base, kind: TOKEN_ERROR_KIND.retry };
};

export { classifyTokenError };
export type { ClassifiedTokenError, TokenErrorKind };
