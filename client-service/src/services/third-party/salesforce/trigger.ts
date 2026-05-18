import JSZip from 'jszip';
import { createApexSecret, salesforceRequest, SalesforceTokens } from './index';
import { SALESFORCE_WEBHOOK_URL } from '../../../constant';
import { IBackupConfig } from '../../../models';
import { getCrmById, getCrmTokens } from '../../crm';
import { timer } from '../../../utils/helper';

const TOOLING_BASE = (instanceUrl: string) => `${instanceUrl}/services/data/v66.0/tooling`;
const NAMESPACE_PREFIX = 'SYX_DVV';
const HANDLER_CLASS_NAME = `DataVaultRecordSyncTriggerHandler`;
const API_VERSION = '66.0';

interface ITriggerResult {
  triggerName: string;
  status: "INITIALIZE" | "CREATED" | "EXIST" | "FAILED" | "DELETED" | "DELETE_FAILED" | "NOT_FOUND" | "INACTIVE" | "INACTIVATE_FAILED";
  permissionSetStatus?: "CREATED" | "EXIST" | "FAILED";
  permissionSetError?: string;
  error?: string
}

// Full qualified name of the External Credential Principal inside the managed package.
// Format: {Namespace}__{ExternalCredentialDeveloperName}-{PrincipalDeveloperName}
const EXTERNAL_CREDENTIAL_PRINCIPAL_NAME = `${NAMESPACE_PREFIX}__Middleware_Endpoint-DataVaultParam`;


// ---------------------------------------------------------------------------
// Fetch a trigger record by name — returns null if not found
// ---------------------------------------------------------------------------
const fetchTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerName: string
): Promise<{ Id: string; Status: string } | null> => {
  const soql = `SELECT Id, Status FROM ApexTrigger WHERE Name = '${triggerName}' LIMIT 1`;
  const url = `${TOOLING_BASE(instanceUrl)}/query?q=${encodeURIComponent(soql)}`;
  try {
    const { data } = await salesforceRequest<{
      totalSize: number;
      records: { Id: string; Status: string }[];
    }>({ url, method: 'GET' }, tokens);

    return data.totalSize > 0 ? data.records[0] : null;
  } catch (err) {
    console.log(`Error fetching trigger ${triggerName}:`, err);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Pure helper — builds the Apex trigger body string for a given object.
// Centralised here so createTriggers and activateTriggers both use the same body.
// ---------------------------------------------------------------------------
const buildTriggerBody = (objectApiName: string): string => {
  const triggerName = `DataVault_${objectApiName}_Trigger`;
  return (
    `trigger ${triggerName} on ${objectApiName} (after insert, after update, after delete, after undelete) {\n` +
    `    try {\n` +
    `        ${NAMESPACE_PREFIX}.${HANDLER_CLASS_NAME}.enqueueSync(Trigger.new, Trigger.old, Trigger.operationType.name());\n` +
    `    } catch (Exception e) {\n` +
    `        System.debug('DataVault: Real-time sync failed for ${objectApiName}. ' + e.getMessage() + ' | TODO: Retry functionality pending. Error log functionality pending.');\n` +
    `    }\n` +
    `}`
  );
};

// ---------------------------------------------------------------------------
// PATCH a single trigger's Status field — shared by activate and inactivate.
// ---------------------------------------------------------------------------
const patchTriggerStatus = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerId: string,
  status: 'Active' | 'Inactive'
): Promise<void> => {
  await salesforceRequest(
    {
      url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger/${triggerId}`,
      method: 'PATCH',
      body: JSON.stringify({ Status: status }),
    },
    tokens
  );
};

// ---------------------------------------------------------------------------
// Creates a single trigger via POST — shared by createTriggers and activateTriggers.
// ---------------------------------------------------------------------------
const createSingleTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<void> => {
  const triggerName = `DataVault_${objectApiName}_Trigger`;
  await salesforceRequest(
    {
      url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger`,
      method: 'POST',
      body: JSON.stringify({
        Name: triggerName,
        TableEnumOrId: objectApiName,
        Body: buildTriggerBody(objectApiName),
        Status: 'Active',
        ApiVersion: API_VERSION,
      }),
    },
    tokens
  );
};

// ---------------------------------------------------------------------------
// Grants permission set access after trigger creation/activation:
//   1. Handler class access
//   2. External Credential Principal access
//   3. Per-trigger class access (for newly created triggers only)
// Mutates the passed results array to set permissionSetStatus on each entry.
// ---------------------------------------------------------------------------
const setupPermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  results: ITriggerResult[]
): Promise<void> => {
  try {
    const permissionSetId = await upsertPermissionSet(instanceUrl, tokens);

    const handlerClassId = await fetchApexClassId(instanceUrl, tokens, HANDLER_CLASS_NAME);
    if (handlerClassId) {
      await grantApexClassAccess(instanceUrl, tokens, permissionSetId, handlerClassId);
    }

    await grantExternalCredentialPrincipalAccess(
      instanceUrl,
      tokens,
      PERMISSION_SET_NAME,
      'DataVault Real-Time Trigger Access',
      EXTERNAL_CREDENTIAL_PRINCIPAL_NAME
    );

    for (const trigger of results) {
      if (trigger.status !== 'CREATED') { continue; }
      try {
        const classId = await fetchApexClassId(instanceUrl, tokens, trigger.triggerName);
        if (classId) {
          await grantApexClassAccess(instanceUrl, tokens, permissionSetId, classId);
        }
        trigger.permissionSetStatus = 'CREATED';
      } catch (error) {
        trigger.permissionSetStatus = 'FAILED';
        trigger.permissionSetError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    console.log('Error during permission set setup:', error);
  }
};

// ---------------------------------------------------------------------------
// Ensure the shared handler ApexClass exists — throws if not installed.
// The class ships with the DataVault managed package (namespace: SYX_DVV).
// Install the package in the org before creating real-time triggers.
// ---------------------------------------------------------------------------
const ensureHandlerClass = async (instanceUrl: string, tokens: SalesforceTokens): Promise<string> => {
  const soql = `SELECT Id FROM ApexClass WHERE Name = '${HANDLER_CLASS_NAME}' LIMIT 1`;
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string }[] }>(
    { url: `${TOOLING_BASE(instanceUrl)}/query?q=${encodeURIComponent(soql)}`, method: 'GET' },
    tokens
  );

  if (data.totalSize === 0) {
    throw new Error(
      `handler_class_not_present: ApexClass '${HANDLER_CLASS_NAME}' was not found in this org. ` +
      `Install the DataVault managed package (namespace: ${NAMESPACE_PREFIX}) before enabling real-time triggers.`
    );
  }

  return data.records[0].Id;
};

// ---------------------------------------------------------------------------
// Resolve an ApexClass Id by name — used for permission set setup
// ---------------------------------------------------------------------------
const fetchApexClassId = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  className: string
): Promise<string | null> => {
  const soql = `SELECT Id FROM ApexClass WHERE Name = '${className}' LIMIT 1`;
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string }[] }>(
    { url: `${TOOLING_BASE(instanceUrl)}/query?q=${encodeURIComponent(soql)}`, method: 'GET' },
    tokens
  );
  return data.totalSize > 0 ? data.records[0].Id : null;
};

// ---------------------------------------------------------------------------
// Permission Set helpers
// ---------------------------------------------------------------------------
const PERMISSION_SET_NAME = 'DataVaultRealTimeTriggerAccess';

const fetchPermissionSetId = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<string | null> => {
  const soql = `SELECT Id FROM PermissionSet WHERE Name = '${PERMISSION_SET_NAME}' LIMIT 1`;
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string }[] }>(
    { url: `${instanceUrl}/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`, method: 'GET' },
    tokens
  );
  return data.totalSize > 0 ? data.records[0].Id : null;
};

// Creates the permission set if absent; returns its Id either way.
const upsertPermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<string> => {
  const existing = await fetchPermissionSetId(instanceUrl, tokens);
  if (existing) { return existing; }

  const { data } = await salesforceRequest<{ id: string }>(
    {
      url: `${instanceUrl}/services/data/v${API_VERSION}/sobjects/PermissionSet`,
      method: 'POST',
      body: JSON.stringify({
        Name: PERMISSION_SET_NAME,
        Label: 'DataVault Real-Time Trigger Access',
        Description:
          'Grants access to the DataVault handler class and all real-time backup triggers created by DataVault.',
      }),
    },
    tokens
  );

  return data.id;
};

// ---------------------------------------------------------------------------
// Fetch the Id of an ExternalCredentialPrincipal by its qualified name.
// Used to grant Named Credential / External Credential access on the permission set.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Grants ExternalCredentialPrincipal access on the permission set via
// Metadata API deploy. This is the only supported approach — ExternalCredential
// and ExternalCredentialPrincipal are metadata types and cannot be queried
// via SOQL (standard or Tooling API).
//
// Deploys a minimal PermissionSet XML with only externalCredentialPrincipalAccesses.
// Salesforce merges this additively — existing class/field accesses are untouched.
// ---------------------------------------------------------------------------
const grantExternalCredentialPrincipalAccess = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetName: string,
  permissionSetLabel: string,
  externalCredentialPrincipalName: string
): Promise<void> => {
  const permissionSetXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <externalCredentialPrincipalAccesses>\n` +
    `        <externalCredentialPrincipal>${externalCredentialPrincipalName}</externalCredentialPrincipal>\n` +
    `        <enabled>true</enabled>\n` +
    `    </externalCredentialPrincipalAccesses>\n` +
    `    <label>${permissionSetLabel}</label>\n` +
    `</PermissionSet>`;

  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    `        <members>${permissionSetName}</members>\n` +
    `        <name>PermissionSet</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const zip = new JSZip();
  zip.file(`permissionsets/${permissionSetName}.permissionset-meta.xml`, permissionSetXml);
  zip.file('package.xml', packageXml);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  // httpRequest hardcodes application/json — use native fetch for multipart upload.
  const deployOptions = JSON.stringify({
    deployOptions: {
      allowMissingFiles: false,
      autoUpdatePackage: false,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      runAllTests: false,
      singlePackage: true,
    },
  });

  const boundary = `----DataVaultBoundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${deployOptions}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="deploy.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`
    ),
    zipBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const deployResponse = await fetch(
    `${instanceUrl}/services/data/v${API_VERSION}/metadata/deployRequest`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!deployResponse.ok) {
    throw new Error(`Metadata deploy request failed: ${await deployResponse.text()}`);
  }

  const { id: jobId } = await deployResponse.json() as { id: string };

  // Poll until the deploy job completes (Salesforce deploys are async).
  while (true) {
    await timer(2000);
    const { data } = await salesforceRequest<{
      deployResult: { done: boolean; success: boolean; errorMessage?: string };
    }>(
      {
        url: `${instanceUrl}/services/data/v${API_VERSION}/metadata/deployRequest/${jobId}?includeDetails=true`,
        method: 'GET',
      },
      tokens
    );

    const { done, success, errorMessage } = data.deployResult;
    if (!done) { continue; }
    if (!success) { throw new Error(`Metadata deploy failed: ${errorMessage ?? 'unknown error'}`); }
    break;
  }
};

// Grants Apex class access on the permission set (idempotent — skips if already present).
const grantApexClassAccess = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string,
  apexClassId: string
): Promise<void> => {
  const soql =
    `SELECT Id FROM SetupEntityAccess ` +
    `WHERE ParentId = '${permissionSetId}' AND SetupEntityId = '${apexClassId}' LIMIT 1`;
  const { data: check } = await salesforceRequest<{ totalSize: number }>(
    { url: `${instanceUrl}/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`, method: 'GET' },
    tokens
  );
  if (check.totalSize > 0) { return; }

  await salesforceRequest(
    {
      url: `${instanceUrl}/services/data/v${API_VERSION}/sobjects/SetupEntityAccess`,
      method: 'POST',
      body: JSON.stringify({ ParentId: permissionSetId, SetupEntityId: apexClassId }),
    },
    tokens
  );
};

// ---------------------------------------------------------------------------
// Create the DataVaultRealTimeTriggerAccess permission set and wire up:
//   1. ApexClassAccess  → the handler class
//   2. ApexClassAccess  → each newly-created trigger's backing class (if any)
// Note: ApexTrigger records themselves are not directly added to permission sets;
// access is controlled via the handler class and the org's profile/permission model.
// ---------------------------------------------------------------------------
const createPermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerNames: string[]
): Promise<{ permissionSetId: string; permissionSetName: string }> => {
  try {
    const permissionSetId = await upsertPermissionSet(instanceUrl, tokens);

    // Grant access to the handler class
    const handlerClassId = await fetchApexClassId(instanceUrl, tokens, HANDLER_CLASS_NAME);
    if (handlerClassId) {
      await grantApexClassAccess(instanceUrl, tokens, permissionSetId, handlerClassId);
    }

    // Grant access to any trigger-backing Apex classes that share the trigger name
    for (let i = 0; i < triggerNames.length; i++) {
      const triggerName = triggerNames[i];
      const classId = await fetchApexClassId(instanceUrl, tokens, triggerName);
      if (classId) {
        await grantApexClassAccess(instanceUrl, tokens, permissionSetId, classId);
      }
    }

    return { permissionSetId, permissionSetName: PERMISSION_SET_NAME };
  } catch (error) {
    console.log('Error creating/upserting permission set:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Create triggers for one or more objects sequentially.
// Handler class is ensured once before all trigger creations.
// Permission set is set up after using only the successfully created triggers.
// ---------------------------------------------------------------------------
const createTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<ITriggerResult[]> => {
  await ensureHandlerClass(instanceUrl, tokens);

  const results: ITriggerResult[] = [];

  for (let i=0; i<objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const triggerName = `DataVault_${objectApiName}_Trigger`;
    try {
      const existing = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (existing?.Status === 'Active') {
        results.push({ triggerName, status: 'EXIST' });
        continue;
      }
      await createSingleTrigger(instanceUrl, tokens, objectApiName);
      results.push({ triggerName, status: 'CREATED' });
      await timer(500);
    } catch (err) {
      console.log(`Error creating trigger ${triggerName}:`, err);
      results.push({ triggerName, status: 'FAILED', error: err instanceof Error ? err.message : String(err) });
    }
  }

  await setupPermissionSet(instanceUrl, tokens, results);
  return results;
};

// ---------------------------------------------------------------------------
// Shared toggle — sets every trigger to the requested Salesforce status.
// ACTIVE  : creates the trigger if absent, patches Inactive → Active,
//           then runs permission set setup for any newly created triggers.
// INACTIVE: skips (NOT_FOUND) if the trigger never existed, patches Active → Inactive.
// ---------------------------------------------------------------------------
const toggleTriggerStatus = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[],
  targetStatus: 'Active' | 'Inactive'
): Promise<ITriggerResult[]> => {
  if (targetStatus === 'Active') {
    await ensureHandlerClass(instanceUrl, tokens);
  }

  const results: ITriggerResult[] = [];

  for (let i=0; i<objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const triggerName = `DataVault_${objectApiName}_Trigger`;
    try {
      const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);

      if (targetStatus === 'Active') {
        if (!trigger) {
          await createSingleTrigger(instanceUrl, tokens, objectApiName);
          results.push({ triggerName, status: 'CREATED' });
          await timer(500);
        } else if (trigger.Status === 'Active') {
          results.push({ triggerName, status: 'EXIST' });
        } else {
          await patchTriggerStatus(instanceUrl, tokens, trigger.Id, 'Active');
          results.push({ triggerName, status: 'CREATED' });
        }
      } else {
        if (!trigger) {
          results.push({ triggerName, status: 'NOT_FOUND' });
        } else if (trigger.Status === 'Inactive') {
          results.push({ triggerName, status: 'INACTIVE' });
        } else {
          await patchTriggerStatus(instanceUrl, tokens, trigger.Id, 'Inactive');
          results.push({ triggerName, status: 'INACTIVE' });
        }
      }
    } catch (err) {
      const label = targetStatus === 'Active' ? 'activating' : 'inactivating';
      console.log(`Error ${label} trigger ${triggerName}:`, err);
      results.push({
        triggerName,
        status: targetStatus === 'Active' ? 'FAILED' : 'INACTIVATE_FAILED',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (targetStatus === 'Active') {
    await setupPermissionSet(instanceUrl, tokens, results);
  }

  return results;
};

// ---------------------------------------------------------------------------
// Delete the DataVaultRealTimeTriggerAccess permission set via Metadata API deploy.
// Called after all triggers are deleted so the permission set is cleaned up too.
// No-op if the permission set doesn't exist.
// ---------------------------------------------------------------------------
const deletePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<void> => {
  const existing = await fetchPermissionSetId(instanceUrl, tokens);
  if (!existing) { return; }

  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    `        <members>${PERMISSION_SET_NAME}</members>\n` +
    `        <name>PermissionSet</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const destructiveXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    `        <members>${PERMISSION_SET_NAME}</members>\n` +
    `        <name>PermissionSet</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const deployOptions = JSON.stringify({
    deployOptions: {
      allowMissingFiles: true,
      checkOnly: false,
      ignoreWarnings: true,
      purgeOnDelete: true,
      rollbackOnError: true,
      runAllTests: false,
      singlePackage: true,
    },
  });

  const zip = new JSZip();
  zip.file('destructiveChanges.xml', destructiveXml);
  zip.file('package.xml', packageXml);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const boundary = `----DataVaultBoundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${deployOptions}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="deploy.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`
    ),
    zipBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const deployResponse = await fetch(
    `${instanceUrl}/services/data/v${API_VERSION}/metadata/deployRequest`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!deployResponse.ok) {
    throw new Error(`Permission set delete deploy failed: ${await deployResponse.text()}`);
  }

  const { id: jobId } = await deployResponse.json() as { id: string };

  while (true) {
    await timer(2000);
    const { data } = await salesforceRequest<{
      deployResult: { done: boolean; success: boolean; errorMessage?: string };
    }>(
      {
        url: `${instanceUrl}/services/data/v${API_VERSION}/metadata/deployRequest/${jobId}?includeDetails=true`,
        method: 'GET',
      },
      tokens
    );

    const { done, success, errorMessage } = data.deployResult;
    if (!done) { continue; }
    if (!success) { throw new Error(`Permission set delete failed: ${errorMessage ?? 'unknown error'}`); }
    break;
  }
};

// ---------------------------------------------------------------------------
// Delete triggers — permanently removes the trigger from the org.
// After all triggers are deleted, the permission set is also deleted.
// No-op for objects whose trigger doesn't exist.
// ---------------------------------------------------------------------------
const deleteTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<ITriggerResult[]> => {
  const results: ITriggerResult[] = [];

  for (let i = 0; i < objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const triggerName = `DataVault_${objectApiName}_Trigger`;
    try {
      const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (!trigger) {
        results.push({ triggerName, status: 'NOT_FOUND' });
        continue;
      }

      await salesforceRequest(
        { url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger/${trigger.Id}`, method: 'DELETE' },
        tokens
      );

      results.push({ triggerName, status: 'DELETED' });
    } catch (err) {
      results.push({ triggerName, status: 'DELETE_FAILED', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Delete the permission set after all triggers are removed.
  try {
    await deletePermissionSet(instanceUrl, tokens);
  } catch (err) {
    console.log('Error deleting permission set:', err);
  }

  return results;
};

// ---------------------------------------------------------------------------
// Unified entry point — resolves CRM tokens + instanceUrl from the config,
// then dispatches to the correct trigger operation.
// ---------------------------------------------------------------------------
type TriggerOperation = 'create' | 'activate' | 'inactivate' | 'delete';

const realTimeTriggerManagement = async (
  operation: TriggerOperation,
  config: IBackupConfig
): Promise<ITriggerResult[]> => {
  const crm = await getCrmById(config.crmId);
  if (!crm) { throw new Error(`crm_not_found:${config.crmId}`); }

  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) { throw new Error(`instance_url_missing:${config.crmId}`); }

  const credentials = getCrmTokens(crm);
  const tokens: SalesforceTokens = {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
    crmId: crm.crmId,
    userId: crm.userId,
    environment: crm.environment,
    customUrl: crm.customUrl,
  };

  const objectApiNames = config.objectNames;

  if (operation === 'create') {
    await createApexSecret(crm.crmId, { webhookSecret: config.backupConfigId });
    return createTriggers(instanceUrl, tokens, objectApiNames);
  }
  if (operation === 'activate') { return toggleTriggerStatus(instanceUrl, tokens, objectApiNames, 'Active'); }
  if (operation === 'inactivate') { return toggleTriggerStatus(instanceUrl, tokens, objectApiNames, 'Inactive'); }
  if (operation === 'delete') { return deleteTriggers(instanceUrl, tokens, objectApiNames); }
  throw new Error(`invalid_operation:${operation}`);
};

export {
  fetchTrigger,
  createTriggers,
  toggleTriggerStatus,
  deleteTriggers,
  deletePermissionSet,
  realTimeTriggerManagement,
  createPermissionSet,
};
