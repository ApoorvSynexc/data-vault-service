import { ICrm } from '../../../models';
import { salesforceRequest, SalesforceTokens, SalesforceAuthExpiredError } from './index';
import { deployMetadata, buildPackageXml, METADATA_API_VERSION } from './metadata-api';
import { listMetadataSoap, readMetadataSoap } from './metadata-listing';
import { callApex, APEX_BASE } from './apex';

// Packaged API/developer name of the ECA shipped with the managed package
// (force-app/internal/360DV/externalClientApps/Data_Vault_Connected_App.eca-meta.xml).
// Every target org is a Subscriber org with the package installed under
// SALESFORCE_NAMESPACE, so this always comes back namespace-prefixed (e.g.
// SYX_DVV__Data_Vault_Connected_App) — see resolveEcaDeveloperName().
export const ECA_API_NAME = 'Data_Vault_Connected_App';
// Display-only now — no longer used to look up the ECA (see resolveEcaDeveloperName).
export const ECA_APP_LABEL = '360 Data Vault';

// Permission Set names (label = human-readable, developer = API/XML name).
// The API name must begin with a letter (Salesforce naming rule for
// Permission Set / any metadata fullName) — '360_Data_Vault_...' violated
// that (leading digit) and failed metadata_deploy_failed in every org, not
// just this one; this isn't an environment-specific issue.
export const ECA_PERMISSION_SET_LABEL = '360 Data Vault ECA Permission Set';
export const ECA_PERMISSION_SET_NAME = 'Data_Vault_ECA_Permission_Set';

// Always 'subscriber' now — scratch/Dev Hub (unpackaged) orgs are no longer a
// real target, so the field is kept only for EcaProvisionResult's shape.
export type EcaProvisionMode = 'subscriber';

export interface EcaProvisionResult {
  mode: EcaProvisionMode;
  ecaFound: boolean;
  ecaDeveloperName: string | null;
  permissionSetCreated: boolean;
  permissionSetAlreadyExists: boolean;
  permissionSetAssignedToEca: boolean;
  externalClientAppUpdated: boolean;
  message: string;
}

interface EcaLookupResult {
  mode: EcaProvisionMode;
  developerName: string | null;
}

/**
 * Resolves the ECA's namespaced developer name. ExternalClientApplication is
 * a Metadata-API-only type — it is not in Tooling API's queryable object list
 * (querying it via /tooling/query returns INVALID_TYPE in every org, not just
 * this one) and isn't a REST/SOAP data sobject either. listMetadata()
 * (Metadata API, SOAP) is the documented way to enumerate existing components
 * of a type without already knowing their fullName.
 *
 * Never throws — a missing ECA (package not installed in this org yet) or an
 * unreachable Metadata API both resolve to developerName: null, so callers can
 * skip the ECA-specific step and keep provisioning whatever else is available.
 */
const resolveEcaDeveloperName = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<EcaLookupResult> => {
  console.log('[eca-permission-set] Checking Metadata API support...');
  let entries;
  try {
    entries = await listMetadataSoap(instanceUrl, tokens, 'ExternalClientApplication', METADATA_API_VERSION);
  } catch (err: any) {
    console.log('[eca-permission-set] Metadata API listMetadata unavailable:', err?.message ?? err);
    return { mode: 'subscriber', developerName: null };
  }

  console.log(
    '[eca-permission-set] Checking ECA availability... found',
    entries.length,
    'ExternalClientApplication component(s):',
    entries.map((e) => e.fullName)
  );

  const namespaced = entries.find((e) => e.fullName.endsWith(`__${ECA_API_NAME}`));
  if (namespaced) {
    console.log('[eca-permission-set] Found ECA:', namespaced.fullName);
    return { mode: 'subscriber', developerName: namespaced.fullName };
  }

  console.log(`[eca-permission-set] '${ECA_API_NAME}' not found under the namespaced name — package not installed in this org yet, skipping ECA step`);
  return { mode: 'subscriber', developerName: null };
};

// Returns true if the Permission Set already exists (by developer/API name).
const permissionSetExists = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetName: string
): Promise<boolean> => {
  const soql = `SELECT Id FROM PermissionSet WHERE Name = '${permissionSetName}' WITH USER_MODE LIMIT 1`;
  const { data } = await salesforceRequest<{ totalSize: number }>(
    {
      url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
      method: 'GET',
    },
    tokens
  );
  return data.totalSize > 0;
};

// Deploys a minimal PermissionSet metadata. The XML has to include a label
// (Salesforce requires it) but no additional access — this is a bare
// "container" permission set used only to gate the ECA's OAuth flow.
const createPermissionSetViaMetadata = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<void> => {
  const permissionSetXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <hasActivationRequired>false</hasActivationRequired>\n` +
    `    <label>${ECA_PERMISSION_SET_LABEL}</label>\n` +
    `</PermissionSet>`;

  await deployMetadata(instanceUrl, tokens, {
    files: [
      {
        path: `permissionsets/${ECA_PERMISSION_SET_NAME}.permissionset-meta.xml`,
        content: permissionSetXml,
      },
    ],
    packageXml: buildPackageXml('PermissionSet', [ECA_PERMISSION_SET_NAME]),
  });
};

// Fetches the ECA's current OAuth policy metadata (commaSeparatedPermissionSet)
// via Tooling API so we can preserve existing entries when we deploy the
// update. Returns an empty list if the ECA has no OAuth policy row yet.
//
// ExtlClntAppOauthConfigurablePolicies follows the same pattern as
// ExternalClientApplication (see resolveEcaDeveloperName above): it is not
// reliably queryable via Tooling API SOQL — attempting it returns
// INVALID_TYPE ("sObject type 'ExtlClntAppOauthPlcyCnfg' is not supported"),
// an internal/abbreviated name Salesforce's query parser resolves to
// internally, not something this code ever references directly. The
// documented replacement is the Metadata API's readMetadata() SOAP call
// (type + fullNames, same session-header auth as listMetadataSoap), which
// isn't implemented yet — tracked as a follow-up. Until then this falls back
// to "assume empty" on any query failure, which means an existing,
// out-of-band-configured commaSeparatedPermissionSet value could be
// overwritten by deployEcaOauthPolicy below rather than preserved — treat
// that as a known limitation, not a bug that needs an unrelated workaround.
const fetchExistingPermittedPermissionSets = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  ecaDeveloperName: string
): Promise<string[]> => {
  try {
    const policyName = await resolveEcaOauthPolicyName(
      instanceUrl,
      tokens,
      ecaDeveloperName
    );

    if (!policyName) {
      return [];
    }

    const xml = await readMetadataSoap(
      instanceUrl,
      tokens,
      'ExtlClntAppOauthConfigurablePolicies',
      [policyName],
      METADATA_API_VERSION
    );

    const csv = xml.match(/<(?:\w+:)?commaSeparatedPermissionSet>([^<]*)<\/(?:\w+:)?commaSeparatedPermissionSet>/)?.[1];

    return csv
      ? csv.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  } catch (err: any) {
    console.log('[eca-permission-set] Failed to fetch existing permittedPermissionSets:', err?.message ?? err);
    return [];
  }
};

// Salesforce requires the ECA Permission Set to already be assigned to the
// admin user before an ExtlClntAppOauthConfigurablePolicies deploy can
// reference it in commaSeparatedPermissionSet — so this must run, and
// succeed, before deployEcaOauthPolicy is ever called (see
// provisionEcaPermissionSet below). Reuses apex.ts's callApex, the same
// outbound wrapper every other Node -> Salesforce call uses: auth is the OAuth
// token carried on `tokens`, and the body is plain JSON. Org-key encryption
// applies only to the inbound Salesforce -> Node path, so nothing is encrypted
// here (see callApex's docblock in apex.ts).
//
// Deliberately does not accept or forward a userId — DataVaultAssignUserToEcaHandler
// (Apex) always resolves the admin user itself from
// Data_Vault_Integration_Config__c.Admin_User_Id__c, so there's nothing for
// this call to pass beyond which Permission Set was just created.
const assignUserToEcaViaApex = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetName: string
): Promise<void> => {
  const response = await callApex<{
    success: boolean;
    data?: { assigned?: boolean; assignmentsCreated?: number; assignmentsAlreadyExisted?: number };
    errorCode?: string;
    message?: string;
  }>(tokens, {
    url: `${APEX_BASE(instanceUrl)}/assign-user-to-eca`,
    method: 'POST',
    body: { permissionSetName },
  });

  if (!response.success || !response.data?.assigned) {
    throw new Error(
      `assign_user_to_eca_failed: ${response.message ?? response.errorCode ?? 'unknown error'}`
    );
  }
  console.log(
    '[eca-permission-set] Assigned admin user to ECA/Data Vault permission sets:',
    response.data
  );
};

// The fullName of the OAuth policy record is NOT the ECA's own developer
// name — confirmed 2026-07-14 by a live "duplicate value found:
// ExternalClientApplicationId duplicates value on Data_Vault_Connected_App_oauthPlcy"
// deploy error: a policy record (Data_Vault_Connected_App_oauthPlcy) already
// existed, auto-generated by Salesforce when the ECA itself was created —
// this is documented behavior (the OAuth policies file "is generated when
// the external client app is deployed"), not an org-specific quirk, and
// ExtlClntAppOauthConfigurablePolicies is explicitly NOT packageable (only
// ExternalClientApplication and ExtlClntAppOauthSettings travel in a 2GP
// package; policies are managed independently per org) — so its fullName can
// never be predicted from the ECA's name alone and must be discovered fresh
// in every org, the same way resolveEcaDeveloperName discovers the ECA
// itself. Deploying with a fullName that doesn't match the org's real
// auto-generated one creates a second, colliding record instead of updating
// the existing one — which is exactly what produced the duplicate-value error.
// ExtlClntAppOauthConfigurablePolicies is explicitly NOT packageable (only
// ExternalClientApplication and ExtlClntAppOauthSettings travel in a 2GP
// package) — policy records are always owned directly by the subscriber
// org's own namespace (i.e. no namespace at all), even when the ECA they
// point at is namespace-prefixed in that same org. Confirmed live: a
// subscriber org with ECA "SYX_DVV__Data_Vault_Connected_App" only ever
// returns the unnamespaced policy record
// "Data_Vault_Connected_App_oauth_defaultPolicy".
//
// Deliberately does NOT use stripNamespace()/SALESFORCE_NAMESPACE here —
// that env var isn't guaranteed to be set in every deploy environment, and
// when it's unset stripNamespace silently no-ops, leaving the namespace on
// and reproducing "Cannot create a new component with the namespace: X"
// (subscriber orgs can only update existing unnamespaced components, never
// create new namespaced ones via the API). The namespace prefix is instead
// parsed directly off ecaDeveloperName — the name Salesforce itself just
// returned for this ECA — so this never depends on external config.
const unnamespacedEcaName = (ecaDeveloperName: string): string =>
  ecaDeveloperName.replace(/^\w+__/, '');

const resolveEcaOauthPolicyName = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  ecaDeveloperName: string
): Promise<string | null> => {
  let entries;
  try {
    entries = await listMetadataSoap(instanceUrl, tokens, 'ExtlClntAppOauthConfigurablePolicies', METADATA_API_VERSION);
  } catch (err: any) {
    console.log('[eca-permission-set] listMetadata for ExtlClntAppOauthConfigurablePolicies unavailable:', err?.message ?? err);
    return null;
  }

  // listMetadata's FileProperties don't include the externalClientApplication
  // reference field, so matching is by naming convention rather than an exact
  // relationship lookup. A prefix match tolerates any exact suffix Salesforce
  // actually uses (observed: both "_oauthPlcy" and Salesforce's own
  // auto-generated "_oauth_defaultPolicy").
  //
  // In a Subscriber org the ECA itself is namespace-prefixed
  // (SYX_DVV__Data_Vault_Connected_App), but Salesforce auto-generates the
  // default OAuth policy record's fullName from the *unnamespaced* developer
  // name (Data_Vault_Connected_App_oauth_defaultPolicy) — confirmed live: a
  // subscriber org only ever returned the unnamespaced record here. Matching
  // solely against ecaDeveloperName never finds it, which used to fall
  // through to the create-with-guessed-name fallback below and fail with
  // "Cannot create a new component with the namespace" (subscriber orgs can't
  // create new namespaced components via the API — only update ones that
  // already exist). Checking the unnamespaced name too finds the real record
  // so the deploy updates it instead of trying to create a colliding one.
  const match = entries.find(
    (e) => e.fullName.startsWith(ecaDeveloperName) || e.fullName.startsWith(unnamespacedEcaName(ecaDeveloperName))
  );
  if (match) {
    console.log('[eca-permission-set] Found existing OAuth policy record:', match.fullName);
    return match.fullName;
  }
  console.log('[eca-permission-set] No existing OAuth policy record found for', ecaDeveloperName, '— found:', entries.map((e) => e.fullName));
  return null;
};

// Deploys the ExtlClntAppOauthConfigurablePolicies metadata to (a) flip
// permittedUsersPolicyType to admin-approved-only, and (b) set
// commaSeparatedPermissionSet to the given list (caller has already computed
// the union — see provisionEcaPermissionSet — so this function does exactly
// one deploy and nothing else, making it easy to skip entirely when nothing
// has changed). policyName is the record's own resolved fullName (see
// resolveEcaOauthPolicyName) — distinct from ecaDeveloperName, which only
// appears inside the XML body as the reference field.
//
// Folder/suffix/field names below are verified against the official Metadata
// API Developer Guide page for this type (developer.salesforce.com,
// meta_extlclntappoauthconfigurablepolicies.htm) — not guessed. Corrected
// 2026-07-14 from an earlier, unverified version of this file that used the
// wrong folder (extlClntAppConfigurablePolicies), wrong suffix
// (.ecaConfigurablePolicies-meta.xml), and fields that don't exist on this
// type at all (isEnabled, permittedUsers, repeated permittedPermissionSets
// elements) — those belong to the separate ExtlClntAppConfigurablePolicies
// type, or don't exist anywhere, and caused "was not found in zipped
// directory" deploy failures.
const deployEcaOauthPolicy = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  ecaDeveloperName: string,
  policyName: string,
  permittedPermissionSets: string[]
): Promise<void> => {
  // commaSeparatedPermissionSet is documented as taking permission set
  // "IDs", but the official sample XML uses a plain API name
  // (<commaSeparatedPermissionSet>PermSetExample</commaSeparatedPermissionSet>)
  // — following the sample's convention, matching how every other reference
  // in this Metadata API surface (including externalClientApplication
  // itself, right below) uses fullName/API name rather than a runtime record
  // Id, which wouldn't even be stable across orgs.
  const policyXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ExtlClntAppOauthConfigurablePolicies xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <externalClientApplication>${ecaDeveloperName}</externalClientApplication>\n` +
    `    <label>${ECA_PERMISSION_SET_LABEL} Policy</label>\n` +
    `    <permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>\n` +
    `    <commaSeparatedPermissionSet>${permittedPermissionSets.join(',')}</commaSeparatedPermissionSet>\n` +
    `</ExtlClntAppOauthConfigurablePolicies>`;

  await deployMetadata(instanceUrl, tokens, {
    files: [
      {
        path: `extlClntAppOauthPolicies/${policyName}.ecaOauthPlcy-meta.xml`,
        content: policyXml,
      },
    ],
    packageXml: buildPackageXml('ExtlClntAppOauthConfigurablePolicies', [policyName]),
  });
};

/**
 * Top-level orchestrator — safe to re-run, and now genuinely idempotent
 * rather than just "safe": both the permission set creation and the ECA
 * OAuth policy deploy are skipped entirely (not just deduplicated after the
 * fact) once the target state is already in place, so re-running this after
 * a full prior success does zero deploys.
 *
 * Never throws for a missing/undiscoverable ECA (expected before the package
 * is installed in this org, or before the org has the component at all): the
 * Permission Set still gets created, and the result reports ecaFound: false
 * with a status message instead of failing the whole call. Only genuine
 * failures (permission set / OAuth policy deploy errors) still throw, since
 * those indicate a real problem rather than an expected pre-install state.
 */
export const provisionEcaPermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  crm: ICrm,
  permissionSetName?: string
): Promise<EcaProvisionResult> => {
  // permissionSetName comes from oauthState (configure-org's permission_set_name)
  // — an admin-supplied, already-existing Permission Set. When provided, it is
  // never created here, only looked up and assigned; falls back to the
  // packaged default only when the caller didn't supply one.
  const usesExistingPermissionSet = Boolean(permissionSetName);
  const effectivePermissionSetName = permissionSetName ?? ECA_PERMISSION_SET_NAME;

  console.log('[eca-permission-set] Checking org capabilities...');
  const { mode, developerName } = await resolveEcaDeveloperName(instanceUrl, tokens);

  console.log('[eca-permission-set] Checking permission set...');
  const alreadyExists = await permissionSetExists(instanceUrl, tokens, effectivePermissionSetName);
  if (alreadyExists) {
    console.log('[eca-permission-set] Permission set already exists — skipping creation:', effectivePermissionSetName);
  } else if (usesExistingPermissionSet) {
    throw new Error(`permission_set_not_found: Permission Set '${effectivePermissionSetName}' does not exist in this org`);
  } else {
    console.log('[eca-permission-set] Permission set not found — creating:', effectivePermissionSetName);
    await createPermissionSetViaMetadata(instanceUrl, tokens);
  }

  if (!developerName) {
    console.log('[eca-permission-set] Skipping unsupported/missing ECA step — permission set provisioning still completed.');
    return {
      mode,
      ecaFound: false,
      ecaDeveloperName: null,
      permissionSetCreated: !alreadyExists,
      permissionSetAlreadyExists: alreadyExists,
      permissionSetAssignedToEca: false,
      externalClientAppUpdated: false,
      message: `External Client App '${ECA_API_NAME}' was not found in this org yet — permission set was still provisioned. Re-run this once the managed package is installed.`,
    };
  }

  console.log('[eca-permission-set] Checking ECA permission-set assignment...');
  const existingPermittedPermissionSets = await fetchExistingPermittedPermissionSets(instanceUrl, tokens, developerName);
  const alreadyAssigned = existingPermittedPermissionSets.includes(effectivePermissionSetName);

  if (alreadyAssigned) {
    console.log('[eca-permission-set] Permission set already assigned to ECA OAuth policy — skipping deploy.');
  } else {
    // Required order, confirmed against a live Salesforce validation error:
    // the ECA Permission Set must already be assigned to the admin user
    // before an ExtlClntAppOauthConfigurablePolicies deploy can reference it.
    // assignUserToEcaViaApex is not wrapped in a try/catch here — if it
    // throws, deployEcaOauthPolicy below never runs, and the throw
    // propagates out of provisionEcaPermissionSet the same way a deploy
    // failure already does, so the caller sees one clear failure instead of
    // a deploy error that doesn't explain the real, earlier cause.
    console.log('[eca-permission-set] Permission set not yet assigned to ECA OAuth policy — assigning to admin user first...');
    await assignUserToEcaViaApex(instanceUrl, tokens, effectivePermissionSetName);

    console.log('[eca-permission-set] Resolving OAuth policy record...');
    // Salesforce auto-generates this record per-org when the ECA is created —
    // its fullName is never the ECA's own name (see resolveEcaOauthPolicyName)
    // and must be discovered, not assumed, or the deploy creates a colliding
    // duplicate instead of updating the real one.
    // Never namespaced when creating: ExtlClntAppOauthConfigurablePolicies
    // isn't packageable, so a subscriber org can only create it under its own
    // (unnamespaced) namespace — see unnamespacedEcaName's docblock above.
    const policyName = (await resolveEcaOauthPolicyName(instanceUrl, tokens, developerName)) ?? `${unnamespacedEcaName(developerName)}_oauthPlcy`;
    console.log('[eca-permission-set] Deploying ECA OAuth policy:', policyName);
    const union = Array.from(new Set([...existingPermittedPermissionSets, effectivePermissionSetName]));

    try {
      await deployEcaOauthPolicy(instanceUrl, tokens, developerName, policyName, union);
    } catch (err) {
      if (!(err instanceof SalesforceAuthExpiredError)) {
        throw err;
      }
      // Documented Salesforce behavior, not a real failure: switching
      // permittedUsersPolicyType to AdminApprovedPreAuthorized can revoke the
      // very session used to request the change. deployMetadata's initial
      // submit uses a plain fetch() with no session-refresh handling — only
      // the status poll goes through salesforceRequest (whose retry-then-
      // SalesforceAuthExpiredError path is what's being caught here) — so a
      // 401 at this exact point means the deploy was already submitted
      // before the session died, and is very likely already applied; we
      // just lost the ability to poll for confirmation.
      console.log(
        '[eca-permission-set] Session invalidated while confirming the OAuth policy deploy — expected when permittedUsersPolicyType changes to AdminApprovedPreAuthorized. The deploy was already submitted and is very likely applied; verify in Setup and have the admin re-authenticate.'
      );
      return {
        mode,
        ecaFound: true,
        ecaDeveloperName: developerName,
        permissionSetCreated: !alreadyExists,
        permissionSetAlreadyExists: alreadyExists,
        permissionSetAssignedToEca: true,
        externalClientAppUpdated: true,
        message:
          'ECA OAuth policy deploy was submitted, but the session used to confirm it was invalidated by the policy change itself — a known Salesforce behavior when permittedUsersPolicyType switches to AdminApprovedPreAuthorized. The change is very likely already applied. Verify in Setup, then have the admin re-authenticate before the next action that needs a live session.',
      };
    }
  }

  console.log('[eca-permission-set] Provisioning complete.');

  return {
    mode,
    ecaFound: true,
    ecaDeveloperName: developerName,
    permissionSetCreated: !alreadyExists,
    permissionSetAlreadyExists: alreadyExists,
    permissionSetAssignedToEca: true,
    externalClientAppUpdated: !alreadyAssigned,
    message: alreadyAssigned
      ? 'Permission set and ECA OAuth policy were already fully provisioned — nothing to deploy.'
      : 'ECA OAuth policy and permission set provisioned successfully.',
  };
};
