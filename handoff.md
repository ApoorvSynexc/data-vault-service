# Session Handoff — Two-Key Encryption Redesign + DataVaultPermissionService Fix

## Goal

Redesign the encryption architecture between the Salesforce package (`DataValue-Salesforce-App`, package `force-app/internal/360DV`) and the Node backend (`data-vault-service/client-service`), replacing a conflated "active key" model with two clearly-separated keys:

- **Bootstrap Key** — shared secret, used only to bootstrap transport (org registration, and the outer envelope that lets Node identify *which* org before it knows that org's key).
- **Org Encryption Key** — unique per org, generated during onboarding, used for all real business data in both directions.

Scope: every layer touching encryption on both sides (Apex crypto service, REST handlers, admin authorization flow, sync queueable, error channel, permission service; Node encryption utils, middleware, controllers, routes, reverse-direction Apex-calling code), plus consistent error-response encryption once an org is identified, plus fixing two confirmed pre-existing bugs (`Webhook_Path__c` field typo, and the reverse-direction Node→Salesforce mismatch where Salesforce encrypted responses but Node never decrypted them).

A second, follow-on goal emerged mid-session: the user hit a live 401 while testing `DataVaultPermissionService.getUserList()` after the redesign shipped, which led to fixing that class's URL/param mismatches against real Node routes and adding a missing Node endpoint.

## Current State

**Both goals are complete and verified.**

- Apex: 138/138 tests passing on `DataVaultPackageOrg` (scoped deploy — see Failed Attempts for why it's scoped). The deploy's own "Failed" status is *only* the org-wide 75%-coverage gate on unrelated pre-existing classes not included in the scoped test run — not a real test failure.
- Node: `tsc --noEmit` clean, zero new ESLint errors on any touched file.
- No stale references to retired methods (`encryptPayload(String)`, `decryptPayload(String)` no-arg, `getActiveEncryptionKey()`) remain anywhere in either codebase — confirmed via full-repo grep.
- `DataVaultPermissionService.cls`'s URL mismatches, missing envelopes on GET/DELETE, and the double-wrapped-response bug are all fixed and covered by updated tests.

**Not done:** a live end-to-end round trip against a running dev server + real Salesforce org callout. Everything below has been verified via automated Apex tests and `tsc`, but not by actually clicking through the LWC permissions/roles UI against a live Node server.

## Files in Flight

### Salesforce (`DataValue-Salesforce-App`, package `force-app/internal/360DV`)
- `classes/config/DataVaultSyncConfig.cls` — fixed `Webhook_Path__c` field typo, deleted `getActiveEncryptionKey()`.
- `classes/services/DataVaultCryptoService.cls` — rewritten with 4 named methods (`encryptBootstrapEnvelope`, `encryptBootstrapOnly`, `decryptOrgPayload`, `encryptOrgResponse`), retired the old no-arg overloads.
- `classes/api/base/DataVaultRestBase.cls` — reverse-direction REST helper, switched to `decryptOrgPayload`/`encryptOrgResponse`.
- `classes/services/DataVaultAdminAuthorizationService.cls` — `authorizeOrganization()` uses `encryptBootstrapOnly`; `requestAuthorizationUrl()` uses `encryptBootstrapEnvelope` + decrypts its now-encrypted response.
- `classes/jobs/queueable/DataVaultRecordSyncQueueable.cls` — uses `encryptBootstrapEnvelope`; moved the encrypt call inside the existing try/catch so a not-yet-registered org fails softly instead of throwing unhandled out of the Queueable.
- `classes/notifications/DataVaultMiddlewareErrorChannel.cls` — uses `encryptBootstrapEnvelope`.
- `classes/services/DataVaultPermissionService.cls` — full pass: fixed `/roles/*` → `/role/*` paths, added `?envelope=...` query-param building for GET/DELETE (`getUserList`, `getRoleList`, `deleteRole`), removed `roleId` from URL path segments, decrypts every response via `decryptOrgPayload`, removed the dead `x-webhook-secret` header.
- Test files updated: `DataVaultCryptoServiceTest.cls`, `DataVaultAdminAuthorizationServiceTest.cls`, `DataVaultAuthControllerTest.cls`, `DataVaultRecordSyncQueueableTest.cls`, `DataVaultPermissionServiceTest.cls`, `DataVaultSyncConfigTest.cls` (removed 3 tests for the deleted `getActiveEncryptionKey()`), `DataVaultRestBaseTest.cls`, `DataVaultAccessibleObjectsHandlerTest.cls`, `DataVaultObjectFieldsMetadataHandlerTest.cls`, `DataVaultPreviewRecordsHandlerTest.cls`, `DataVaultValidateSoqlHandlerTest.cls`, `DataVaultObjectChildsHandlerTest.cls`, `DataVaultObjectRecordCountHandlerTest.cls`, `DataVaultQueryCountHandlerTest.cls`.

### Node (`data-vault-service/client-service/src`)
- `utils/encryption.ts` — added `encryptWithKey`.
- `utils/salesforce-crypto.ts` — added `encryptSalesforceResponse`, `encryptOrgDirect`/`decryptOrgDirect`, `decryptSalesforceQueryRequest`; `decryptSalesforceRequest` now accepts `payload ?? params`.
- `middlewares/salesforce/index.ts` (new file) — `attachDecryptedSalesforceRequest(source)` shared middleware, decrypts once per request into `req.salesforcePayload`.
- `middlewares/joi/salesforce/index.ts` — validators read `req.salesforcePayload` instead of decrypting inline; error responses bypass `makeResponse` and send the encrypted envelope directly (see Failed Attempts).
- `middlewares/authentication/index.ts` — removed dead, unused `salesforceAuthenticate` (superseded single-layer decrypt middleware, never wired to any route).
- `controller/v1/public/authorize.ts` — `authorizeUserHandler` reads `req.salesforcePayload`, encrypts its response; `authorizeOrganizationHandler` stays plaintext (chicken-and-egg exception — it hands back the very key needed to decrypt anything else).
- `controller/v1/salesforce/index.ts` — all handlers read `req.salesforcePayload`; all responses (success + error) bypass `makeResponse` and send `encryptSalesforceResponse(...)` directly at the top level; added new `updatePermissionsHandler` (reassigns a user's role + updates that role's permission set).
- `services/third-party/salesforce/apex.ts` — new `callApex` helper wraps every one of the 9 exported functions with org-key-direct encrypt/decrypt (previously sent fully plain JSON while Salesforce encrypted responses — a live mismatch).
- `routes/v1/salesforce.route.ts` — wired `attachDecryptedSalesforceRequest('body'|'query')` ahead of every route; added `PUT /permissions`.
- `routes/v1/public.routes.ts` — wired the new middleware ahead of `authorize-admin`.

## What We Have Changed

1. **Core crypto redesign (both sides)** — replaced the single "active key" concept with 4 explicit-purpose methods on each side, eliminating any silent bootstrap-key fallback for business data.
2. **Response encryption policy** — once an org is identified (envelope successfully unwrapped), every response is Org-Key encrypted, success or error. Pre-identification failures stay plain 401 (no key exists yet to encrypt with).
3. **Reverse direction fixed** — Node calling into Salesforce's own REST API (`apex.ts` → `/services/apexrest/.../v1/data-vault/*`) now actually encrypts requests and decrypts responses with the org key, closing a live mismatch where Salesforce always encrypted but Node never decrypted.
4. **`DataVaultPermissionService.cls` end-to-end fix** — URLs corrected, GET/DELETE envelope-building added, responses decrypted, dead header removed, and the previously-missing `PUT /permissions` Node endpoint added.
5. **Response-wrapping bug fixed** — `/salesforce/*` handlers and Joi validators now send the encrypted envelope at the top level of the HTTP response instead of nested under `makeResponse`'s `{success,message,data,meta}.data`, matching the convention Apex's `decryptOrgPayload()` expects (and matching `authorize.ts`'s existing convention).
6. **Test coverage** — all touched Apex classes have updated/new tests; all pass (138/138 across the full battery, 36/36 in the follow-on permission-service-focused run).

## Failed Attempts

- **First full deploy attempt failed** on an unrelated `PermissionSet` (`Data_Vault_Permission_Set`) referencing a missing `ExternalCredentialPrincipal` in `DataVaultPackageOrg` — a pre-existing org-config gap, not caused by this work. Worked around by scoping the deploy's `--source-dir` list to exclude `permissionsets/` (classes + objects + customMetadata + namedCredentials + externalCredentials + extlClntAppOauthSettings + externalClientApps + remoteSiteSettings + labels).
- **Deploying just `classes/` (no objects/customMetadata) failed with 117 component errors** — "Field does not exist" for `Webhook_Path__c`, `Bootstrap_Key__c`, `Org_Encryption_Key__c`, etc. The first full-package deploy attempt had rolled back atomically (due to the PermissionSet failure above), so those fields were never actually committed to the org; a classes-only deploy against that rolled-back state had nothing to reference. Fixed by including the full dependency set in the second deploy attempt.
- **`DataVaultCryptoServiceTest.cls` compile failure**: used `inner` as a local variable name — `inner` is an Apex-reserved identifier (for inner classes). Renamed to `innerBody`.
- **`DataVaultAdminAuthorizationServiceTest.testRequestAuthorizationUrl_reRequestByDifferentUser_rebindsToNewRequester` failed with `DUPLICATE_VALUE`**: adding an org-key upsert to `setupSuccessfulCalloutMock()` meant a *second*, later blind `upsert new Data_Vault_Integration_Config__c(SetupOwnerId=...)` in the same test tried to insert a second row for the same SetupOwnerId. Fixed by fetching the existing `getOrgDefaults()` record and mutating it instead of constructing a new one.
- **Initial scoping mistake**: `DataVaultRecordSyncQueueableTest.cls` and `DataVaultPermissionServiceTest.cls` were judged "no changes needed" early on, based only on checking whether their assertions inspected request/response *body content*. This missed that `encryptBootstrapEnvelope()` now *throws* when no org key is configured — a structural break, not a content-assertion break. Both required adding an org key to their `setupConfig()`.
- **Unhandled-exception gap in `DataVaultRecordSyncQueueable.sendPayload()`**: the encrypt call sat *outside* the method's only try/catch (which wrapped just the callout), so a not-yet-registered org would throw an unhandled exception out of a fire-and-forget Queueable. Fixed by moving the encrypt call inside the try block.
- **Response double-wrapping bug** (see item 5 above) shipped initially in the first pass of the redesign and wasn't caught until the user's live 401 debugging session surfaced it — the fix (bypass `makeResponse` for encrypted envelopes) was applied retroactively to `controller/v1/salesforce/index.ts` and `middlewares/joi/salesforce/index.ts`.

## Next Steps

1. **Do a live end-to-end verification** — start the Node dev server (`ngrok.yml` at repo root suggests a tunnel setup already exists for this) and a real Salesforce org, then click through the LWC permissions/roles UI (`dvPermissionHandler`, `dvRolesHandler`) to confirm `getUserList`, `getRoleList`, `updateUserPermissions` (the new endpoint), `createRole`, `updateRole`, `deleteRole` all round-trip correctly. This has only been verified via Apex unit tests with mocked callouts, never against a real Node server.
2. **Confirm the `updatePermissionsHandler` business logic matches intent** — its semantics (reassign the user's role + overwrite that role's `permissions` list to `modules`) were *inferred* from reading the LWC's `dvPermissionHandler.savePermissions()`/`buildPermissionPayload()` and the existing `updateRole`/`updateUser` services, since there was no existing Node endpoint to reference. Worth a quick sanity check against actual intended UX before relying on it.
3. **Two known, unrelated data-shape mismatches were spotted but left out of scope** (flag to fix separately if they matter):
   - `getUsersHandler`'s returned users carry `role.permissions`, but the LWC's `mapUserPermission()` reads `apiUser.modules` directly — likely never populates correctly today.
   - `getSourcingPermissions()`'s Node response is wrapped in `makeResponse`'s `{success,message,data,meta}`, but the LWC's `loadAll()` reads `sourcingData?.modules` expecting `{modules:[...]}` at the top level.
4. **LWC jest suite wasn't rerun this session** — no LWC files were touched, so this is low-risk, but worth a sanity run if picking this back up.
5. **Stale project memory**: `project_datavault_permission_service_broken.md` (in the Claude memory store) documents the exact bug that's now fixed — it should be updated or removed so future sessions don't act on stale information. (Being handled as part of this handoff.)
