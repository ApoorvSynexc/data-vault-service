import { salesforceRequest, SalesforceTokens } from './index';
import { SALESFORCE_WEBHOOK_URL } from '../../../constant';

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
// Create the handler ApexClass + ApexTrigger for a given object.
// Trigger name convention: DataVault{ObjectApiName}Trigger
// Handler class is shared across all objects — skipped if already exists.
// ---------------------------------------------------------------------------
const createTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<{ triggerName: string; alreadyExists: boolean }> => {
  const triggerName = `DataVault_${objectApiName}_Trigger`;

  const existing = await fetchTrigger(instanceUrl, tokens, triggerName);
  if (existing?.Status === 'Active') return { triggerName, alreadyExists: true };

  // Create handler class if it doesn't exist yet (shared across all objects)
  const classCheckSoql = `SELECT Id FROM ApexClass WHERE Name = '${HANDLER_CLASS_NAME}' LIMIT 1`;
  const { data: classCheck } = await salesforceRequest<{ totalSize: number }>(
    { url: `${TOOLING_BASE(instanceUrl)}/query?q=${encodeURIComponent(classCheckSoql)}`, method: 'GET' },
    tokens
  );

  if (classCheck.totalSize === 0) {
    await salesforceRequest(
      {
        url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexClass`,
        method: 'POST',
        body: JSON.stringify({
          Name: HANDLER_CLASS_NAME,
          Body: HANDLER_CLASS_BODY,
          ApiVersion: API_VERSION,
        }),
      },
      tokens
    );
  }

  // Create the trigger
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

  return { triggerName, alreadyExists: false };
};

// ---------------------------------------------------------------------------
// Delete the ApexTrigger for a given object.
// No-op if the trigger doesn't exist.
// ---------------------------------------------------------------------------
const deleteTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<{ triggerName: string; deleted: boolean }> => {
  const triggerName = `DataVault_${objectApiName}_Trigger`;

  const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);
  if (!trigger) return { triggerName, deleted: false };

  const triggerId = trigger.Id;
  await salesforceRequest(
    { url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger/${triggerId}`, method: 'DELETE' },
    tokens
  );

  return { triggerName, deleted: true };
};

export { fetchTrigger, createTrigger, deleteTrigger };
