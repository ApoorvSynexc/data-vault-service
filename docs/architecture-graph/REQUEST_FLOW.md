# Request Flow

How an HTTP request moves through both services.

## client-service Request Pipeline

```
HTTP Request (from browser/mobile/Salesforce webhook)
  |
  v
Express Router (trust proxy 1, cookieParser, cors, json body parser)
  |
  v
morganMiddleware (logs method, path, status, duration)
  |
  v
Route group middleware (varies by route group; corrected 2026-07-14 against `routes/v1/index.ts`):
  |
  +-- /v1/auth/*           → (none at router level — individual routes add rate-limit/validation)
  +-- /v1/internal/*       → internalAuth (X-Internal-Secret header, timingSafeEqual)
  +-- /v1/public/*         → (none at router level — only `PUT /webhook/salesforce` adds webhookAuth)
  +-- /v1/salesforce/*     → (no router-level middleware — secured per-route via attachDecryptedSalesforceRequest,
  |                           the two-key Bootstrap+org-key scheme; salesforceAuthenticate doesn't exist, see
  |                           modules/authentication-middleware.md)
  |
  |   -- everything below shares one `router.use(authenticate); router.use(aclGateway);` in v1/index.ts --
  +-- /v1/user/*           → authenticate → aclGateway
  +-- /v1/crm/*            → authenticate → aclGateway
  +-- /v1/backup-config/*  → authenticate → aclGateway
  +-- /v1/archival-config/*→ authenticate → aclGateway
  +-- /v1/backup-job/*     → authenticate → aclGateway
  +-- /v1/dashboard/*      → authenticate → aclGateway
  +-- /v1/destination/*    → authenticate → aclGateway
  +-- /v1/storage/*        → authenticate → aclGateway (missing from the previous version of this doc)
  +-- /v1/restore/*        → authenticate → aclGateway (mount prefix is `/restore`, not `/restore-retrieve`;
                              there is no double `authenticate` — same single global chain as every route above)
  |
  v
Controller function (via wrapController / asyncHandler wrapper)
  |
  +-- asyncHandler catches all errors:
  |     SalesforceAuthExpiredError → 401 + salesforce_reauth_required
  |     Error                     → 400 + error.message
  |
  v
makeResponse(req, res, statusCode, success, messageKey, payload, meta)
  |
  +-- Looks up Accept-Language header (en supported)
  +-- Translates messageKey via LOCALIZATION[language][messageKey]
  +-- res.status(code).send({ success, message, data, meta })
```

## authenticate Middleware Detail

```
1. Read accessToken from req.cookies.accessToken
2. If absent → 401 unauthorized
3. jwt.verify(token, JWT_ACCESS_SECRET) → payload { userId, sessionId }
4. getSession(sessionId) → must exist and status === SESSION_STATUS.active
5. getUser({ userId, status: [active, inactive] }) → must exist
6. If user.status === inactive → 403 blocked_or_removed
7. req.user = user; req.sessionId = sessionId
8. next()
```

## aclGateway Middleware Detail

```
1. allowedModules = [user, crm, backup-job, dashboard, destination]
   (these pass through without permission check)
2. For other submodules: look up aclGatewayPermissions[submodule]
3. Find entry matching { path, method, permissions }
4. If user role.permissions includes any required permission → next()
5. Else → 403 insufficient_permission
```

## backup-service Request Pipeline

```
HTTP Request (from client-service internal calls only)
  |
  v
Express Router (json body parser)
  |
  v
morganMiddleware
  |
  v
Controller (via wrapController)
  |
  v
makeResponse (same shape: { success, message, data, meta })
```

Note: backup-service has no auth middleware. Security relies on network isolation (the service should not be publicly reachable). Callers are trusted.

## Response Shape

All endpoints (both services) return:
```json
{
  "success": true | false,
  "message": "localized string",
  "data": null | any,
  "meta": {}
}
```

Pagination meta shape:
```json
{
  "limit": 10,
  "nextCursor": "base64url string | null",
  "totalRecords": 42,
  "totalPages": 5
}
```
