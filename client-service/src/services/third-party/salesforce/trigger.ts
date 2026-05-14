import { createApexSecret, salesforceRequest, SalesforceTokens } from './index';
import { SALESFORCE_WEBHOOK_URL } from '../../../constant';
import { IBackupConfig } from '../../../models';
import { getCrmById, getCrmTokens } from '../../crm';

const TOOLING_BASE = (instanceUrl: string) => `${instanceUrl}/services/data/v66.0/tooling`;
const NAMESPACE_PREFIX = 'SYX_DVV';
const HANDLER_CLASS_NAME = `DataVaultRecordSyncTriggerHandler`;
const API_VERSION = '66.0';


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

  const { data } = await salesforceRequest<{
    totalSize: number;
    records: { Id: string; Status: string }[];
  }>({ url, method: 'GET' }, tokens);

  return data.totalSize > 0 ? data.records[0] : null;
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
  const permissionSetId = await upsertPermissionSet(instanceUrl, tokens);

  // Grant access to the handler class
  const handlerClassId = await fetchApexClassId(instanceUrl, tokens, HANDLER_CLASS_NAME);
  if (handlerClassId) {
    await grantApexClassAccess(instanceUrl, tokens, permissionSetId, handlerClassId);
  }

  // Grant access to any trigger-backing Apex classes that share the trigger name
  await Promise.all(
    triggerNames.map(async (triggerName) => {
      const classId = await fetchApexClassId(instanceUrl, tokens, triggerName);
      if (classId) {
        await grantApexClassAccess(instanceUrl, tokens, permissionSetId, classId);
      }
    })
  );

  return { permissionSetId, permissionSetName: PERMISSION_SET_NAME };
};

// ---------------------------------------------------------------------------
// Create triggers for one or more objects in parallel.
// Handler class is ensured once before all trigger creations.
// After all triggers settle, the permission set is created/updated using only
// the trigger names that were successfully created in this run.
// ---------------------------------------------------------------------------
const createTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<{ triggerName: string; created: boolean; error?: string }[]> => {
  await ensureHandlerClass(instanceUrl, tokens);

  const results: { triggerName: string; created: boolean; error?: string }[] = [];

  for (let i = 0; i < objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const triggerName = `DataVault_${objectApiName}_Trigger`;

    try {
      const existing = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (existing?.Status === 'Active') {
        results.push({ triggerName, created: false, error: 'Trigger already exists' });
        continue;
      }

      await salesforceRequest(
        {
          url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger`,
          method: 'POST',
          body: JSON.stringify({
            Name: triggerName,
            TableEnumOrId: objectApiName,
            Body: `trigger ${triggerName} on ${objectApiName} (after insert, after update, after delete, after undelete) {\n    try {\n        ${NAMESPACE_PREFIX}.${HANDLER_CLASS_NAME}.enqueueSync(Trigger.new, Trigger.old, Trigger.operationType.name());\n    } catch (Exception e) {\n        System.debug('DataVault: Real-time sync failed for ${objectApiName}. ' + e.getMessage() + ' | TODO: Retry functionality pending. Error log functionality pending.');\n    }\n}`,
            Status: 'Active',
            ApiVersion: API_VERSION,
          }),
        },
        tokens
      );

      results.push({ triggerName, created: true });
    } catch (err) {
      results.push({ triggerName, created: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Run permission set setup only for triggers that were successfully created.
  const successfulTriggerNames = results
    .filter((r) => r.created)
    .map((r) => r.triggerName);

  if (successfulTriggerNames.length > 0) {
    await createPermissionSet(instanceUrl, tokens, successfulTriggerNames);
  }

  return results;
};

// ---------------------------------------------------------------------------
// Delete triggers for one or more objects in parallel.
// No-op for objects whose trigger doesn't exist.
// ---------------------------------------------------------------------------
const deleteTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<{ triggerName: string; deleted: boolean; error?: string }[]> => {
  const results: { triggerName: string; deleted: boolean; error?: string }[] = [];

  for (let i = 0; i < objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const triggerName = `DataVault_${objectApiName}_Trigger`;

    try {
      const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (!trigger) {
        results.push({ triggerName, deleted: false });
        continue;
      }

      await salesforceRequest(
        {
          url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger/${trigger.Id}`,
          method: 'DELETE',
        },
        tokens
      );

      results.push({ triggerName, deleted: true });
    } catch (err) {
      results.push({ triggerName, deleted: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
};

// ---------------------------------------------------------------------------
// Unified entry point — resolves CRM tokens + instanceUrl from the config,
// then creates or deletes triggers for all objectNames in the config.
// ---------------------------------------------------------------------------
type TriggerOperation = 'create' | 'delete';

const realTimeTriggerManagement = async (
  operation: TriggerOperation,
  config: IBackupConfig
): Promise<{ triggerName: string; created: boolean; error?: string }[] | { triggerName: string; deleted: boolean; error?: string }[]> => {
  const crm = await getCrmById(config.crmId);
  if (!crm) {
    throw new Error(`crm_not_found:${config.crmId}`);
  }

  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error(`instance_url_missing:${config.crmId}`);
  }

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
    const triggerResults = await createTriggers(instanceUrl, tokens, objectApiNames);
    return triggerResults;
  } else {
    const deleteResults = await deleteTriggers(instanceUrl, tokens, objectApiNames);
    return deleteResults;
  }
};

export { fetchTrigger, createTriggers, deleteTriggers, realTimeTriggerManagement, createPermissionSet };
