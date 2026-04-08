import { salesforceRequest, SalesforceTokens } from './index';
import { SALESFORCE_WEBHOOK_URL } from '../../../constant';
import { IBackupConfig } from '../../../models';
import { getCrmById, getCrmTokens } from '../../crm';

const TOOLING_BASE = (instanceUrl: string) => `${instanceUrl}/services/data/v66.0/tooling`;
const HANDLER_CLASS_NAME = 'DataVaultRecordSyncTriggerHandler';
const API_VERSION = '66.0';

const HANDLER_CLASS_BODY = `
public class ${HANDLER_CLASS_NAME} implements Queueable, Database.AllowsCallouts {
    private List<SObject> newRecords;
    private List<SObject> oldRecords;
    private String operation;
    private String objectApiName;

    public ${HANDLER_CLASS_NAME}(List<SObject> newRecs, List<SObject> oldRecs, String op, String objName) {
        this.newRecords    = newRecs;
        this.oldRecords    = oldRecs;
        this.operation     = op;
        this.objectApiName = objName;
    }

    public static void enqueueSync(List<SObject> newRecs, List<SObject> oldRecs, String op) {
        String objName = newRecs != null && !newRecs.isEmpty()
            ? newRecs[0].getSObjectType().getDescribe().getName()
            : oldRecs[0].getSObjectType().getDescribe().getName();
        System.enqueueJob(new ${HANDLER_CLASS_NAME}(newRecs, oldRecs, op, objName));
    }

    public void execute(QueueableContext ctx) {
        List<SObject> records = newRecords != null ? newRecords : oldRecords;
        Map<String, Object> payload = new Map<String, Object>{
            'records'       => records,
            'orgId'         => UserInfo.getOrganizationId(),
            'operation'     => this.operation,
            'objectApiName' => this.objectApiName
        };
        HttpRequest req = new HttpRequest();
        req.setEndpoint('${SALESFORCE_WEBHOOK_URL}');
        req.setMethod('PUT');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(10000);
        req.setBody(JSON.serialize(payload));
        new Http().send(req);
    }
}
`.trim();

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

  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string; Status: string }[] }>(
    { url, method: 'GET' },
    tokens
  );

  return data.totalSize > 0 ? data.records[0] : null;
};

// ---------------------------------------------------------------------------
// Ensure the shared handler ApexClass exists — runs once before any triggers
// ---------------------------------------------------------------------------
const ensureHandlerClass = async (instanceUrl: string, tokens: SalesforceTokens): Promise<void> => {
  const soql = `SELECT Id FROM ApexClass WHERE Name = '${HANDLER_CLASS_NAME}' LIMIT 1`;
  const { data } = await salesforceRequest<{ totalSize: number }>(
    { url: `${TOOLING_BASE(instanceUrl)}/query?q=${encodeURIComponent(soql)}`, method: 'GET' },
    tokens
  );

  if (data.totalSize > 0) return;

  await salesforceRequest(
    {
      url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexClass`,
      method: 'POST',
      body: JSON.stringify({ Name: HANDLER_CLASS_NAME, Body: HANDLER_CLASS_BODY, ApiVersion: API_VERSION }),
    },
    tokens
  );
};

// ---------------------------------------------------------------------------
// Create triggers for one or more objects in parallel.
// Handler class is ensured once before all trigger creations.
// ---------------------------------------------------------------------------
const createTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<{ triggerName: string; created: boolean }[]> => {
  await ensureHandlerClass(instanceUrl, tokens);

  return Promise.all(
    objectApiNames.map(async (objectApiName) => {
      const triggerName = `DataVault_${objectApiName}_Trigger`;

      const existing = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (existing?.Status === 'Active') return { triggerName, created: false };

      await salesforceRequest(
        {
          url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger`,
          method: 'POST',
          body: JSON.stringify({
            Name: triggerName,
            TableEnumOrId: objectApiName,
            Body: `trigger ${triggerName} on ${objectApiName} (after insert, after update, after delete, after undelete) {\n    ${HANDLER_CLASS_NAME}.enqueueSync(Trigger.new, Trigger.old, Trigger.operationType.name());\n}`,
            Status: 'Active',
            ApiVersion: API_VERSION,
          }),
        },
        tokens
      );

      return { triggerName, created: true };
    })
  );
};

// ---------------------------------------------------------------------------
// Delete triggers for one or more objects in parallel.
// No-op for objects whose trigger doesn't exist.
// ---------------------------------------------------------------------------
const deleteTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<{ triggerName: string; deleted: boolean }[]> => {
  return Promise.all(
    objectApiNames.map(async (objectApiName) => {
      const triggerName = `DataVault_${objectApiName}_Trigger`;

      const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (!trigger) return { triggerName, deleted: false };

      await salesforceRequest(
        { url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger/${trigger.Id}`, method: 'DELETE' },
        tokens
      );

      return { triggerName, deleted: true };
    })
  );
};

// ---------------------------------------------------------------------------
// Unified entry point — resolves CRM tokens + instanceUrl from the config,
// then creates or deletes triggers for all objectNames in the config.
// ---------------------------------------------------------------------------
type TriggerOperation = 'create' | 'delete';

const realTimeTriggerManagement = async (
  operation: TriggerOperation,
  config: IBackupConfig
): Promise<void> => {
  const crm = await getCrmById(config.crmId);
  if (!crm) throw new Error(`crm_not_found:${config.crmId}`);

  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) throw new Error(`instance_url_missing:${config.crmId}`);

  const credentials = getCrmTokens(crm);
  const tokens: SalesforceTokens = {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
    crmId: crm.crmId,
  };

  const objectApiNames = config.objectNames;

  if (operation === 'create') {
    await createTriggers(instanceUrl, tokens, objectApiNames);
  } else {
    await deleteTriggers(instanceUrl, tokens, objectApiNames);
  }
};

export { fetchTrigger, createTriggers, deleteTriggers, realTimeTriggerManagement };
