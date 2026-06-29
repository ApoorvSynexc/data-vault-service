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

### 4. Salesforce Encrypted Payload (salesforce-to-service sync)
- Salesforce Apex encrypts its payload body with AES-256-CBC using the platform ENCRYPTION_KEY.
- `salesforceAuthenticate` middleware decrypts the body/query param ciphertext+iv.
- Decrypted payload is stored as `req.salesforcePayload`.

### 5. Salesforce PKCE OAuth (CRM connections and social login)
- Client calls `GET /auth/salesforce` → receives `{ url, state }`.
- `state` and `codeVerifier` are stored in OAUTH_STATE_TABLE (TTL: short expiry).
- User is redirected to Salesforce auth URL with `code_challenge = SHA256(codeVerifier)` base64url.
- Salesforce redirects back with `code + state`.
- `GET /auth/salesforce/callback` exchanges code for tokens using code_verifier (PKCE).
- Tokens stored encrypted on user record (`crmCredential`).

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
