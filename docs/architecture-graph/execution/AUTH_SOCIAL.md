# Execution Flow: Social Auth (Salesforce PKCE OAuth)

Step-by-step trace for Salesforce CRM connection and social login.

## Social Login Flow (new user login via Salesforce)

### Step 1: GET /v1/auth/salesforce

```typescript
// Optional body: { environment, customUrl, redirectUri }
const { url, codeVerifier, state } = getSalesforceLoginUrl(
  undefined,          // state auto-generated (16 random hex bytes)
  redirectUri,
  environment,        // 'production' | 'sandbox' | 'custom'
  customUrl,
);

// Store state + codeVerifier for callback verification
await createOauthState(state, codeVerifier);
// OAUTH_STATE_TABLE: { state, codeVerifier, ttl: now + 10min }

return 200 { url, state }
// url = https://login.salesforce.com/services/oauth2/authorize?
//         response_type=code&client_id=...&redirect_uri=...&state=...
//         &code_challenge=SHA256(codeVerifier)&code_challenge_method=S256
```

### Step 2: User authorizes in browser → Salesforce redirects to callback

```
GET /v1/auth/salesforce/callback?code={code}&state={state}
```

### Step 3: salesforceCallbackHandler (in auth/social-login.ts)

```typescript
const { code, state } = req.query;

// Retrieve and validate state
const oauthState = await getOauthState(state);
if (!oauthState) return 400 invalid_state;
await deleteOauthState(state); // consume state (one-time use)

const codeVerifier = oauthState.codeVerifier;

// Exchange code for tokens
const tokenResponse = await getSalesforceToken(code, codeVerifier, environment, customUrl);
// POST to Salesforce /services/oauth2/token
// body: { grant_type: authorization_code, code, client_id, client_secret, redirect_uri, code_verifier }
// Returns: { access_token, refresh_token, instance_url, ... }

// Get Salesforce user profile
const profileResult = await getSalesforceProfile({ accessToken, refreshToken }, environment, customUrl);
// GET {instanceUrl}/services/oauth2/userinfo
// Returns: { user_id, organization_id, email, name, picture, ... }
```

### Step 4: User lookup or creation

```typescript
const sfUserId = profileResult.data.user_id;
const organizationId = profileResult.data.organization_id;

// Look up user by crmProfileUserId (Salesforce user ID)
let user = await getUserByCrmProfileUserId(sfUserId);

if (!user) {
  // New user — create with Salesforce profile
  user = await createUser({
    userId: uuid(),
    authProvider: AUTH_PROVIDER.salesforce,
    contactEmail: profileResult.data.email,
    crmProfile: {
      instanceUrl, organizationId, userId: sfUserId,
      username: profileResult.data.preferred_username,
      email: profileResult.data.email,
    },
    crmCredential: encrypt(JSON.stringify({ access_token, refresh_token })),
    status: STATUS.active,
    role: { roleId: defaultRoleId, name: 'Admin' },
  });
}

// Update existing user's tokens (access_token may have changed)
if (existingUser) {
  await updateUser({ userId: user.userId }, {
    crmCredential: encrypt(JSON.stringify({ access_token, refresh_token })),
    crmProfile: { ...updatedProfile },
  });
}
```

### Step 5: Create session and set cookies

```typescript
const session = await createSession({
  sessionId: uuid(),
  userId: user.userId,
  status: SESSION_STATUS.active,
  ttl: now + parseExpiryToSeconds(JWT_REFRESH_EXPIRY),
});

const { accessToken: jwtAccess, refreshToken: jwtRefresh } = generateTokens(user.userId, session.sessionId);
res.cookie('accessToken', jwtAccess, { httpOnly: true });
res.cookie('refreshToken', jwtRefresh, { httpOnly: true });
return 200 { user (without password) }
```

## CRM Connection Flow (existing user connecting a Salesforce org)

Same as above, but the user is already authenticated (via `authenticate` middleware).

In `backup-config/createHandler`, when creating a REALTIME config:

```typescript
// After config creation, create Apex triggers
const triggerResults = await realTimeTriggerManagement('create', config);
// createApexSecret: sends backupConfigId to Salesforce as webhook secret
// createTriggers: creates DataVault_{ObjectName}_Trigger for each object
// setupPermissionSet: creates DataVaultRealTimeTriggerAccess permission set
// grants handler class access + external credential principal access
```

## Token Refresh (during Salesforce API calls)

When any Salesforce API call returns 401 (access token expired):

### In client-service (via salesforceRequest)

```typescript
// Attempt API call → 401
// refreashSalesforceToken(user.crmCredential.refresh_token, environment, customUrl)
// POST Salesforce /services/oauth2/token { grant_type: refresh_token, ... }
// If success: 
//   encrypt new { access_token, refresh_token }
//   updateUser({ userId }, { crmCredential: encrypted })
// If failure: throw SalesforceAuthExpiredError
```

### In backup-service (via api-request.salesforceRequest)

```typescript
// Attempt API call → 401
// GET client-service /v1/internal/refresh-token?backupConfigId=...
// client-service: loads config → finds userId → loads user → refreshes token → returns new token
// backup-service: tokens.accessToken = refreshed.access_token (mutate in-place)
// Retry original call
// If refresh fails: throw SalesforceAuthExpiredError → job FAILED
```
