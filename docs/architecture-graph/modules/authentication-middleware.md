# Module: client-service/middlewares/authentication/index.ts

## Purpose
Validates JWT cookies on every protected request. Populates `req.user` and `req.sessionId` for downstream handlers.

## Exports
- `authenticate` — Express middleware for standard user auth

Corrected 2026-07-14: `salesforceAuthenticate` does not exist in this file (or anywhere in the codebase) — it was removed as dead code during an earlier "Two-Key Encryption Redesign" session (see this repo's root `handoff.md`: "removed dead, unused `salesforceAuthenticate` — superseded single-layer decrypt middleware, never wired to any route"). Salesforce-encrypted payloads are handled instead by `attachDecryptedSalesforceRequest` in `middlewares/salesforce/index.ts`, which implements the two-key (Bootstrap Key + per-org key) scheme documented in [SECURITY.md](../SECURITY.md#4-salesforce-encrypted-payload--two-key-model-salesforce-to-service-sync) — not the single master-key AES-256-CBC decrypt described below for the old middleware.

## authenticate

### Flow
```
1. Read req.cookies.accessToken
2. If absent → 401 unauthorized
3. jwt.verify(token, JWT_ACCESS_SECRET) → payload { userId, sessionId, ... }
4. getSession(payload.sessionId) → must exist + status = ACTIVE
5. getUser({ userId: payload.userId, status: [active, inactive] }) → must exist
6. If user.status = inactive → 403 blocked_or_removed
7. req.user = user; req.sessionId = payload.sessionId
8. next()
```

### Session Validation
Session is validated on EVERY request (not just at login). This means:
- Logging out (revoking session) immediately invalidates all tokens using that session.
- Expired sessions (TTL-based) automatically reject requests.
- Blocking a user (status = inactive) immediately returns 403 on next request.

### DynamoDB Calls per Request
2 reads: `getSession()` + `getUser()`. No caching.

## Error Cases

| Scenario | Response |
|---|---|
| No accessToken cookie | 401 unauthorized |
| JWT verify fails (expired, tampered) | 401 unauthorized |
| Session not found | 401 unauthorized |
| Session status = REVOKED | 401 unauthorized |
| User not found | 401 unauthorized |
| User status = inactive | 403 blocked_or_removed |
| User status = deleted | 401 (getUser filters out deleted) |

## Performance Note
Every authenticated request makes 2 DynamoDB reads. At scale, this should be considered for caching (e.g., short-lived in-memory session cache with invalidation on logout).

Currently: no caching. Each request is independently verified.
