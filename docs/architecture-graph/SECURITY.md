# Security

All authentication layers, encryption schemes, and secrets.

## Authentication Layers

### 1. JWT + httpOnly Cookie (client-service user sessions)
- Access token: signed with JWT_ACCESS_SECRET, expiry JWT_ACCESS_EXPIRY (e.g. "15m").
- Refresh token: signed with JWT_REFRESH_SECRET, expiry JWT_REFRESH_EXPIRY (e.g. "7d").
- Both set as httpOnly cookies (inaccessible to client-side JS).
- Cookie set via `res.cookie('accessToken', token, { httpOnly: true, ... })`.
- `authenticate` middleware reads `req.cookies.accessToken`, verifies signature, then validates session from DynamoDB.
- Session must be status=ACTIVE. Inactive user → 403 (not 401).

### 2. Internal Secret (inter-service auth)
- INTERNAL_SECRET env var (shared between client-service and backup-service).
- Sent as `X-Internal-Secret: {secret}` header.
- `internalAuth` middleware uses `timingSafeEqual` to prevent timing attacks.
- Guards all `/v1/internal/*` routes on client-service.
- backup-service is the sole caller of these routes.

### 3. Webhook Auth (Salesforce realtime webhooks)
- Salesforce Apex callouts include `X-Webhook-Secret: {backupConfigId}` header.
- `webhookAuth` middleware looks up the backupConfigId in BACKUP_CONFIG_TABLE.
- If found → request is authentic (the backupConfigId is the shared secret).
- No HMAC or signed body verification — relies on backupConfigId secrecy.

### 4. Salesforce Encrypted Payload — two-key model (salesforce-to-service sync)
Corrected 2026-07-14: `salesforceAuthenticate` does not exist — it was removed as dead code in an earlier "Two-Key Encryption Redesign" session (see this repo's root `handoff.md`), superseded by `attachDecryptedSalesforceRequest` (`middlewares/salesforce/index.ts`), wired ahead of most `/salesforce/*` routes in `routes/v1/salesforce.route.ts`.

- **Bootstrap Key** (`ENCRYPTION_KEY` env var, shared secret, mirrors Apex's `Bootstrap_Key__c`): used only (a) to register a new org (`/auth/authorize-org`'s `org_details`, decrypted with plain `decrypt()`), and (b) as the *outer* envelope layer that lets the service identify which org a request is for before it knows that org's own key.
- **Org Encryption Key** (unique per org, `generateOrgEncryptionKey()`, stored on the CRM record as `crm.encryptionKey`, mirrors Apex's `Org_Encryption_Key__c`): used for the *inner* layer of every request once an org is registered, and for encrypting every response back to Salesforce.
- **Two-layer requests** (`decryptSalesforceRequest` / `attachDecryptedSalesforceRequest`, `utils/salesforce-crypto.ts`): the whole body (or, for GET/DELETE, a single `?envelope=` query param) is Bootstrap-Key-decrypted first to reveal `{ orgId, payload | params }`; `orgId` is looked up to fetch the org's key, which then decrypts the inner `payload`/`params` envelope. Populated onto `req.salesforcePayload` as `{ orgId, crm, plaintext }`.
- **`/auth/authorize-org` is the one exception that stays single-layer**: there's no org key to wrap with yet on a first-time call (registering the org is what produces one), so its whole body is Bootstrap-Key-decrypted directly, not via `attachDecryptedSalesforceRequest`.
- **Responses**: `encryptSalesforceResponse(crm, payload)` always encrypts directly with the org's own key once an org is identified — success or business-logic error alike. Apex decrypts these with `DataVaultCryptoService.decryptOrgPayload()` / `decryptPayload(rawBody, orgKey)`.
- **`/salesforce/confirm-org-authorized`** is a documented exception: Bootstrap-only (no org key may exist yet), since its purpose is checking whether the org is registered at all.

### 5. Salesforce OAuth (CRM connections, dashboard social login, and admin authorization)
Corrected 2026-07-14: the previous version of this section referenced `GET /auth/salesforce` / `GET /auth/salesforce/callback`, which don't exist — the actual routes are `/auth/social-login` and `/auth/social-login/callback` (`controller/v1/auth/social-login.ts`). There are three distinct entry points into the same underlying `getSalesforceLoginUrl()`/`getSalesforceToken()` helpers (`services/third-party/salesforce/index.ts`), each building its own `state`/PKCE pair via `createOAuthState`:

- **Dashboard "Sign in with Salesforce"**: `GET /auth/social-login?authProvider=salesforce` → `{ authorizationUrl }` → browser redirect → `GET /auth/social-login/callback?code&state` exchanges the code (PKCE, `code_verifier`), stores `crmCredential` (`{access_token, refresh_token}`, master-key encrypted) and `crmProfile.instanceUrl` (Salesforce's own `instance_url` from the token response — authoritative for later API calls) on the user record, and sets the dashboard's own JWT session cookies.
- **Salesforce admin-authorization popup**: `DataVaultAdminAuthorizationService.authorizeOrganization()` (Apex) → `/auth/authorize-org` → returns a Salesforce OAuth authorize URL built the same way, with `redirect_uri = SALESFORCE_LOGIN_REDIRECT_URI` (same value as the dashboard flow above, so both land on the **same** `/auth/social-login/callback`). The admin never sees an intermediate dashboard page — the LWC opens this URL directly.
- **CRM connect/reconnect** (`GET /crm/connect` → `GET /crm/callback`, `controller/v1/crm/index.ts`): a separate, similar OAuth round trip for attaching/re-attaching a CRM to an already-logged-in dashboard user.
- All three request `scope: 'api refresh_token'` explicitly (added 2026-07-14 — previously no `scope` param was sent at all, which is worth keeping in mind if any Connected App's default scope doesn't include `api`).
- `getSalesforceToken()`'s `redirect_uri` must exactly match whichever `redirect_uri` was used to build the authorize URL (OAuth2 requirement); as of 2026-07-14 the social-login and admin-authorization flows pass it explicitly instead of relying on `getSalesforceToken`'s hardcoded default.

## Encryption Schemes

### client-service: AES-256-CBC
- Master key: ENCRYPTION_KEY env var (base64-encoded 32 bytes).
- `encrypt(plaintext)` → `{ ciphertext: base64, iv: base64 }`.
- Per-tenant encryption via HKDF:
  - `deriveKey(userId)` = HKDF-SHA256(masterKey, salt=userId, info='data-vault-tenant-v1', len=32).
  - `encryptForTenant(plaintext, userId)` → ciphertext prefixed with 'v2:'.
- `decrypt({ ciphertext, iv }, userId?)`:
  - ciphertext starts with 'v2:' → use per-tenant derived key (userId required).
  - no prefix → use master key (Salesforce-sent payloads and legacy records).

### backup-service: AES-256-GCM
- ENCRYPTION_KEY env var (64-char hex = 32 bytes).
- `encrypt(plaintext)` → `{ ciphertext: hex, iv: hex, authTag: hex }`.
- `decrypt({ ciphertext, iv, authTag })` → plaintext.
- GCM provides authenticated encryption — any tampering detected by authTag mismatch.
- Used for: backup job source credentials, backup job destination config.

### What Gets Encrypted
- User.crmCredential — Salesforce access_token + refresh_token (client-service, AES-256-CBC).
- Destination.ciphertext — S3 { bucketName, region, accessKeyId, secretAccessKey } (client-service, AES-256-CBC).
- BackupJob.source — ISource { access_token, refresh_token, instanceUrl, crmName, crmId } (backup-service, AES-256-GCM).
- BackupJob.destination — IDestinationConfig (backup-service, AES-256-GCM).
- Salesforce-to-client encrypted API responses (AES-256-CBC, master key).

## ACL / Role-Based Access Control

- Every user has a `role: { roleId, name, permissions[] }`.
- `aclGateway` middleware enforces permission checks for non-allowlisted modules.
- Allowed-without-check modules: `user`, `crm`, `backup-job`, `dashboard`, `destination`.
- Other modules (backup-config, archival-config, restore-retrieve) require specific permissions.
- Permission values: `backup.read`, `backup.write`, `backup.execute`, `backup.delete`, `archival.*`, `restore.*`, `connection.*`, etc.
- Permissions defined in `defaultPermissions` asset (10 modules × multiple levels).
- Roles are stored in ROLE_TABLE; permission list is on the role record.

## Password Security
- bcrypt with 10 salt rounds.
- Passwords are never returned in API responses (explicitly set to `undefined` before sending).
- `changePasswordHandler` verifies old password before updating.

## Rate Limiting
- Applied to `/v1/auth/*` routes via `express-rate-limit`.
- Configuration in `client-service/src/middlewares/rate-limit/index.ts`.
- Prevents brute-force OTP/password attacks.

## Secrets Management
- All secrets are environment variables.
- No secrets in code or committed config files.
- ENCRYPTION_KEY must be 64-char hex for backup-service (validated at startup).
- INTERNAL_SECRET shared between both services — must match exactly.
