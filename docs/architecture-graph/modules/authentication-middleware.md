# Module: client-service/middlewares/authentication/index.ts

## Purpose
Validates JWT cookies on every protected request. Populates `req.user` and `req.sessionId` for downstream handlers.

## Exports
- `authenticate` — Express middleware for standard user auth
- `salesforceAuthenticate` — Express middleware for Salesforce-encrypted payloads

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

## salesforceAuthenticate

### Flow
```
1. Check req.body for { ciphertext, iv }
   OR check req.query for { ciphertext, iv }
2. If neither found → 400 params_required
3. decrypt({ ciphertext, iv }) → AES-256-CBC with master key
4. req.salesforcePayload = JSON.parse(decrypted)
5. next()
```

### When Used
- `POST /v1/salesforce/upsert-users` — Salesforce Apex sends encrypted user data.
- `GET /v1/salesforce/permissions` — Optional encrypted query param.

### Key Note
`salesforceAuthenticate` uses the MASTER key (no userId prefix, no HKDF). The Salesforce Apex class encrypts with the same ENCRYPTION_KEY. This is NOT per-tenant encryption.

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
