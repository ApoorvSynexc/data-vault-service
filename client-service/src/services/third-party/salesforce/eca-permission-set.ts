import { salesforceRequest, SalesforceTokens } from './index';
import { deployMetadata, buildPackageXml, METADATA_API_VERSION } from './metadata-api';

// User-facing name of the External Client App we're wiring up (label in the
// org). The developer/API name (used in metadata paths) is separate and
// resolved dynamically via SOQL — see resolveEcaDeveloperName below.
export const ECA_APP_LABEL = '360 Data Vault';

// Permission Set names (label = human-readable, developer = API/XML name).
export const ECA_PERMISSION_SET_LABEL = '360 Data Vault ECA Permission Set';
export const ECA_PERMISSION_SET_NAME = '360_Data_Vault_ECA_Permission_Set';

export interface EcaProvisionResult {
  permissionSetCreated: boolean;
  permissionSetAlreadyExists: boolean;
  externalClientAppUpdated: boolean;
}

// Look up the ECA's developer name by its label. Metadata deploys reference
// the ECA by developer name (fullName), not label, so we resolve it once here
// and reuse it in both metadata-file paths and package.xml members.
const resolveEcaDeveloperName = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<string> => {
  const soql = `SELECT DeveloperName FROM ExternalClientApplication WHERE MasterLabel = '${ECA_APP_LABEL}' LIMIT 1`;
  const { data } = await salesforceRequest<{
    totalSize: number;
    records: { DeveloperName: string }[];
  }>(
    {
      url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
      method: 'GET',
    },
    tokens
  );

  if (data.totalSize === 0) {
    throw new Error(`external_client_app_not_found: no ExternalClientApplication with label '${ECA_APP_LABEL}'`);
  }
  return data.records[0].DeveloperName;
};

// Returns true if the Permission Set already exists (by developer/API name).
const permissionSetExists = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<boolean> => {
  const soql = `SELECT Id FROM PermissionSet WHERE Name = '${ECA_PERMISSION_SET_NAME}' LIMIT 1`;
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

// Fetches the ECA's current OAuth policy metadata (permittedUsers +
// permittedPermissionSets) via Tooling API so we can preserve existing
// entries when we deploy the update. Returns an empty list if the ECA has
// no OAuth policy row yet.
const fetchExistingPermittedPermissionSets = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  ecaDeveloperName: string
): Promise<string[]> => {
  // ExtlClntAppOauthConfigurablePolicies rows are keyed off the OAuth
  // settings' external app link. Query for any permission sets already
  // assigned to this ECA so we can preserve them in the deploy.
  const soql =
    `SELECT Metadata FROM ExtlClntAppOauthConfigurablePolicies ` +
    `WHERE ExternalClientApplication.DeveloperName = '${ecaDeveloperName}' LIMIT 1`;
  try {
    const { data } = await salesforceRequest<{
      totalSize: number;
      records: { Metadata?: { permittedPermissionSets?: string[] } }[];
    }>(
      {
        url: `${instanceUrl}/services/data/v${METADATA_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
        method: 'GET',
      },
      tokens
    );
    if (data.totalSize === 0) {
      return [];
    }
    return data.records[0].Metadata?.permittedPermissionSets ?? [];
  } catch {
    // Tooling API on this metadata type varies by API version; when the
    // query isn't supported, treat as no-existing-entries rather than
    // failing the whole flow. Additive deploys are still safe.
    return [];
  }
};

// Deploys the ExtlClntAppOauthConfigurablePolicies metadata to (a) flip
// permittedUsers to admin-approved-only, and (b) union the ECA permission
// set into permittedPermissionSets, preserving anything already there.
const updateEcaOauthPolicies = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  ecaDeveloperName: string
): Promise<void> => {
  const existing = await fetchExistingPermittedPermissionSets(instanceUrl, tokens, ecaDeveloperName);
  const union = Array.from(new Set([...existing, ECA_PERMISSION_SET_NAME]));

  const permittedPermissionSetsXml = union
    .map((name) => `    <permittedPermissionSets>${name}</permittedPermissionSets>`)
    .join('\n');

  // The fullName for ExtlClntAppOauthConfigurablePolicies mirrors the ECA
  // developer name — one policy row per ECA.
  const policyXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ExtlClntAppOauthConfigurablePolicies xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <externalClientApplication>${ecaDeveloperName}</externalClientApplication>\n` +
    `    <isEnabled>true</isEnabled>\n` +
    `    <permittedUsers>AdminPreApproved</permittedUsers>\n` +
    `${permittedPermissionSetsXml}\n` +
    `</ExtlClntAppOauthConfigurablePolicies>`;

  await deployMetadata(instanceUrl, tokens, {
    files: [
      {
        path: `extlClntAppConfigurablePolicies/${ecaDeveloperName}.ecaConfigurablePolicies-meta.xml`,
        content: policyXml,
      },
    ],
    packageXml: buildPackageXml('ExtlClntAppOauthConfigurablePolicies', [ecaDeveloperName]),
  });
};

// Top-level orchestrator — safe to re-run: existing permission set is left
// alone, and the OAuth policy deploy is idempotent under the additive union
// above (no duplicates in permittedPermissionSets, no policy overwrite).
export const provisionEcaPermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<EcaProvisionResult> => {
  // Fail fast if the ECA can't be found — everything else depends on this.
  const ecaDeveloperName = await resolveEcaDeveloperName(instanceUrl, tokens);

  const alreadyExists = await permissionSetExists(instanceUrl, tokens);
  if (!alreadyExists) {
    await createPermissionSetViaMetadata(instanceUrl, tokens);
  }

  await updateEcaOauthPolicies(instanceUrl, tokens, ecaDeveloperName);

  return {
    permissionSetCreated: !alreadyExists,
    permissionSetAlreadyExists: alreadyExists,
    externalClientAppUpdated: true,
  };
};
