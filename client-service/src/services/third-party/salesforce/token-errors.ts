// Typed errors thrown by TokenAuthority and salesforceRequest. asyncHandler
// (utils/helper.ts) maps any SalesforceTokenError to its httpStatus + code,
// and the internal refresh API forwards the same code to backup-service.

export class SalesforceTokenError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly retryAfterSec?: number;

  constructor(message: string, httpStatus: number, code: string, retryAfterSec?: number) {
    super(message);
    this.name = new.target.name;
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

// The user must reconnect Salesforce (refresh token expired/revoked, or no
// credential on file). Existing callers catch this by class, so its name and
// constructor signature are unchanged.
export class SalesforceAuthExpiredError extends SalesforceTokenError {
  constructor(
    message = 'Salesforce session expired. User must re-authenticate.',
    code = 'salesforce_reauth_required'
  ) {
    super(message, 401, code);
  }
}

// Refresh succeeded but Salesforce still rejected the replayed call — the
// user lost API access or the token belongs to a different org. Extends
// SalesforceAuthExpiredError so "reconnect" handling still applies.
export class SalesforceAuthRejectedAfterRefreshError extends SalesforceAuthExpiredError {
  constructor() {
    super(
      'Salesforce rejected the request again after a successful token refresh.',
      'salesforce_auth_rejected_after_refresh'
    );
  }
}

// A refresh is running (or a durable retry is scheduled). Never block a UI
// request for this — respond 503 with Retry-After.
export class SalesforceTokenRefreshInProgressError extends SalesforceTokenError {
  constructor(retryAfterSec = 30) {
    super(
      'Salesforce token refresh is in progress.',
      503,
      'token_refresh_in_progress',
      retryAfterSec
    );
  }
}

export class SalesforceOrgInactiveError extends SalesforceTokenError {
  constructor() {
    super('The Salesforce organization is inactive.', 403, 'salesforce_org_inactive');
  }
}

export class SalesforceIpRestrictedError extends SalesforceTokenError {
  constructor() {
    super(
      'Salesforce rejected the token request because of login IP restrictions.',
      403,
      'salesforce_ip_restricted'
    );
  }
}

// Our Connected App / ECA credentials were rejected — a platform fault, not
// the customer's.
export class SalesforceUnavailableError extends SalesforceTokenError {
  constructor(retryAfterSec = 60) {
    super('Salesforce token service is unavailable.', 503, 'salesforce_unavailable', retryAfterSec);
  }
}
