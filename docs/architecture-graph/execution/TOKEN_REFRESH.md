# Execution Flow: Salesforce Token Auto-Refresh

How Salesforce access tokens are refreshed automatically when they expire.

## Context

Salesforce access tokens expire after a configurable period (org-level setting, typically 2 hours or 30 days). When a token expires, any Salesforce API call returns HTTP 401. Both services handle this transparently.

## client-service Token Refresh

File: `client-service/src/services/third-party/salesforce/index.ts` — `salesforceRequest()`

```typescript
const salesforceRequest = async (options, tokens) => {
  try {
    return await makeCall(tokens.accessToken);
  } catch (error) {
    if (!error?.message?.startsWith('HTTP Error 401')) throw error; // only handle 401
    
    // Access token expired — try refresh
    try {
      const refreshed = await refreashSalesforceToken(tokens.refreshToken, tokens.environment, tokens.customUrl);
      // POST Salesforce /services/oauth2/token
      // { grant_type: refresh_token, client_id, client_secret, refresh_token }
      
      const newAccessToken = refreshed.access_token;
      
      // Persist new tokens to user record in DynamoDB
      if (tokens.userId) {
        const encrypted = encrypt(JSON.stringify({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
        }));
        await updateUser({ userId: tokens.userId }, { crmCredential: encrypted });
      }
      
      return await makeCall(newAccessToken); // retry once with new token
    } catch {
      throw new SalesforceAuthExpiredError(); // refresh failed — user must reconnect
    }
  }
};
```

Used by: apex.ts (all Apex REST calls), trigger.ts (Tooling/Metadata API calls).

## backup-service Token Refresh

File: `backup-service/src/services/third-party/salesforce/api-request.ts` — `salesforceRequest()`

backup-service does NOT have the Salesforce client_secret or direct access to the user's refresh token. It delegates refresh to client-service via internal endpoint.

```typescript
const salesforceRequest = async (options, tokens) => {
  try {
    return await makeCall(tokens.accessToken);
  } catch (error) {
    if (!error?.message?.startsWith('HTTP Error 401')) throw error;
    
    try {
      const refreshed = await refreshSalesforceToken(tokens.backupConfigId);
      // GET client-service /v1/internal/refresh-token?backupConfigId=...
      // Headers: X-Internal-Secret: {INTERNAL_SECRET}
      
      tokens.accessToken = refreshed.access_token; // mutate shared object in-place
      // This is important: all subsequent pages in a pagination loop
      // will use the new token automatically (same tokens object reference)
    } catch {
      throw new SalesforceAuthExpiredError();
    }
    
    return await makeCall(tokens.accessToken);
  }
};
```

## client-service Internal Refresh Endpoint

File: `client-service/src/controller/v1/internal/index.ts` — `refreshTokenHandler`

```
GET /v1/internal/refresh-token?backupConfigId={id}
X-Internal-Secret: {INTERNAL_SECRET}
```

```typescript
const config = await getBackupConfigById(backupConfigId);
const user = await getUser({ userId: config.userId });

const { access_token, refresh_token } = JSON.parse(decrypt(user.crmCredential));
const crm = await getCrmById(user.crmId);

const refreshed = await refreashSalesforceToken(refresh_token, crm.environment, user.customUrl);
// Salesforce refresh call

// Persist new tokens
await updateUser({ userId: user.userId }, {
  crmCredential: encrypt(JSON.stringify({
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
  })),
});

return 200 { access_token: refreshed.access_token }
// Note: backup-service only gets access_token, not refresh_token
```

## When Refresh Also Fails

`SalesforceAuthExpiredError` is thrown. In backup-service runner:
```typescript
catch (err) {
  if (err instanceof SalesforceAuthExpiredError) {
    await updateBackupJob(backupJobId, {
      status: 'FAILED',
      errorMessage: 'Salesforce session expired. User must re-authenticate.',
    });
    // Notify client-service
    await httpRequest({ ... eventType: 'backup.failed', ... });
    return;
  }
  throw err;
}
```

In client-service controllers (via asyncHandler):
```typescript
if (error instanceof SalesforceAuthExpiredError) {
  return makeResponse(req, res, 401, false, 'salesforce_reauth_required');
}
```

The UI should detect `salesforce_reauth_required` and redirect the user to re-authorize the Salesforce connection.

## Shared Token Object (mutation pattern)

The `tokens` object in backup-service is passed by reference. When `tokens.accessToken` is mutated:
```typescript
tokens.accessToken = refreshed.access_token;
```
All callers sharing the same object (pagination loop iterations, concurrent page fetches) automatically use the refreshed token. This avoids the need to pass the new token through every calling layer.
