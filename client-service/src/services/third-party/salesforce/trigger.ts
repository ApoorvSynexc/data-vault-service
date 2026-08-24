import JSZip from 'jszip';
import { createHash } from 'crypto';
import { salesforceRequest, SalesforceTokens } from './index';
import { IBackupConfig, ITriggerResult, IUser } from '../../../models';
import { getCrmById } from '../../crm';
import { appendObjectsToBackupConfig } from '../../backup-config';
import { getUser, getDecryptedCrmCredential } from '../../user';
import { timer } from '../../../utils/helper';
import { getMasterChildApiNames } from './apex';
import { withNamespace } from '../../../utils/salesforce-namespace';
import { SALESFORCE_NAMESPACE } from '../../../constant';
import { logger } from '../../../middlewares';

const HANDLER_CLASS_NAME = `DataVaultRecordSyncTriggerHandler`;
const API_VERSION = '66.0';

// Unqualified name of the External Credential Principal inside the managed
// package. Format once namespaced: {Namespace}__{ExternalCredentialDeveloperName}-{PrincipalDeveloperName}
// — withNamespace prefixes the whole string once, which lands the namespace on
// exactly the ExternalCredential half, matching that format.
const EXTERNAL_CREDENTIAL_PRINCIPAL_NAME = `DataVaultAPIExt-DataVaultAPIUser`;

// ---------------------------------------------------------------------------
// Real-time sync is delivered as record-triggered Flows, not Apex triggers.
//
// A subscriber org's Apex must reach 75% coverage to deploy, and a managed
// package's own tests do not count towards it — so an Apex trigger had to ship
// with a generated test class, per object, that inserted a real record to cover
// itself. Flows carry no coverage requirement at all, so the whole generator is
// gone: the Flow just calls the package's existing @InvocableMethod
// (DataVaultRecordSyncTriggerHandler.enqueueSyncFromFlow), which funnels into
// the same enqueueSync the Apex trigger used to call.
//
// Two Flows per object: one after-save Flow covering create+update, one for
// delete. The handler still needs to know which operation fired, so the
// create-or-update Flow decides it at runtime from $Record__Prior (blank on
// create) instead of costing a third Flow.
//
// Delete is before-delete: Salesforce offers no after-delete record-triggered
// Flow. Harmless here — the handler enqueues a Queueable holding the records in
// memory, so it still has the data after the row is gone.
// ---------------------------------------------------------------------------
const OPERATION_FORMULA_NAME = 'Sync_Operation';

const FLOW_EVENTS = [
  {
    suffix: 'Upsert',
    recordTriggerType: 'CreateAndUpdate',
    triggerType: 'RecordAfterSave',
    operationFormula: `IF(ISBLANK({!$Record__Prior.Id}), "AFTER_INSERT", "AFTER_UPDATE")`,
  },
  {
    suffix: 'Delete',
    recordTriggerType: 'Delete',
    triggerType: 'RecordBeforeDelete',
    operationFormula: null,
  },
] as const;

// Flows from the three-per-object era. Left in place they fire alongside the new
// ones and double every sync, so they are removed wherever the new ones are
// deployed or deleted.
// ponytail: drop this and its two call sites once no org has a pre-Upsert config.
const LEGACY_FLOW_SUFFIXES = ['Insert', 'Update'] as const;

// The Apex trigger name this object's automation used to ship under. Only the
// legacy cleanup paths need it now — nothing is stored under this name.
const triggerNameFor = (objectApiName: string): string =>
  `DataVault_${objectApiName.replace('__c', '')}_Trigger`;

const flowStemFor = (objectApiName: string): string =>
  `DataVault_${objectApiName.replace('__c', '')}`;

const flowNamesFor = (objectApiName: string): string[] =>
  FLOW_EVENTS.map((event) => `${flowStemFor(objectApiName)}_${event.suffix}_Flow`);

const legacyFlowNamesFor = (objectApiName: string): string[] =>
  LEGACY_FLOW_SUFFIXES.map((suffix) => `${flowStemFor(objectApiName)}_${suffix}_Flow`);

// Configs written before flows replaced Apex triggers stored only a lossy
// `DataVault_<Object>_Trigger` label. Recover the exact SObject API name from
// the config's own objectNames, falling back to undoing the string surgery.
const objectApiNameOf = (config: IBackupConfig, result: ITriggerResult): string =>
  result.objectApiName ??
  (config.objectNames ?? []).find((name) => triggerNameFor(name) === result.triggerName) ??
  String(result.triggerName).replace('DataVault_', '').replace('_Trigger', '');

// ---------------------------------------------------------------------------
// Production orgs only expose the Metadata API for changing metadata, so every
// write in this file is a deploy — nothing here touches the Tooling API. Reads
// go through the standard Data API, where ApexClass, ApexTrigger and
// FlowDefinitionView are all queryable.
// ---------------------------------------------------------------------------
const soqlUrl = (instanceUrl: string, soql: string): string =>
  `${instanceUrl}/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`;

// Which of these flows exist, and which are live. A name absent from the map
// does not exist in the org at all.
const fetchFlowStates = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  flowNames: string[]
): Promise<Map<string, boolean>> => {
  const inList = flowNames.map((name) => `'${name}'`).join(',');
  const { data } = await salesforceRequest<{ records: { ApiName: string; IsActive: boolean }[] }>(
    {
      url: soqlUrl(instanceUrl, `SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName IN (${inList})`),
      method: 'GET',
    },
    tokens
  );

  return new Map((data.records ?? []).map((record) => [record.ApiName, record.IsActive]));
};

// Deactivation is a FlowDefinition deploy with activeVersionNumber 0 — the one
// Metadata API route to turning a flow off, and a prerequisite for deleting it.
// (FlowDefinition is deprecated for authoring flows; setting the active version
// is the part that still works and has no replacement.)
const deactivateFlows = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  flowNames: string[]
): Promise<void> => {
  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    flowNames.map((name) => `        <members>${name}</members>\n`).join('') +
    `        <name>FlowDefinition</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const flowDefinitionXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<FlowDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <activeVersionNumber>0</activeVersionNumber>\n` +
    `</FlowDefinition>`;

  const zip = new JSZip();
  for (const flowName of flowNames) {
    zip.file(`flowDefinitions/${flowName}.flowDefinition-meta.xml`, flowDefinitionXml);
  }
  zip.file('package.xml', packageXml);

  await deployMetadata(
    instanceUrl,
    tokens,
    zip,
    {
      allowMissingFiles: false,
      autoUpdatePackage: false,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      singlePackage: true,
    },
    `Flow deactivate: ${flowNames.join(', ')}`
  );
};

// ---------------------------------------------------------------------------
// Flow metadata.
//
// $Record is a single record and the invocable takes a List<SObject>, so the
// record is assigned into a collection variable first. Flow bulkifies invocable
// calls across the whole DML batch into one Apex invocation, which is what the
// handler's collectFlowRecords stitches back into a single record list.
// ---------------------------------------------------------------------------
const buildRecordTriggeredFlow = (
  objectApiName: string,
  flowName: string,
  event: (typeof FLOW_EVENTS)[number]
): string => {
  const actionName = withNamespace(HANDLER_CLASS_NAME);
  const label = flowName.replace(/_/g, ' ');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <apiVersion>${API_VERSION}</apiVersion>\n` +
    `    <actionCalls>\n` +
    `        <name>Enqueue_Record_Sync</name>\n` +
    `        <label>Enqueue Record Sync</label>\n` +
    `        <locationX>176</locationX>\n` +
    `        <locationY>287</locationY>\n` +
    `        <actionName>${actionName}</actionName>\n` +
    `        <actionType>apex</actionType>\n` +
    // Both List<SObject> fields on the invocable's input class are generic, and
    // Flow refuses to deploy an action call that leaves a generic parameter
    // unmapped — that is the `Specify the data type mapping for input parameter
    // T__records` deploy error. The element is <dataTypeMappings>;
    // <genericTypeMappings> is not part of the Flow schema and was ignored, so
    // the mappings never registered.
    `        <dataTypeMappings>\n` +
    `            <typeName>T__records</typeName>\n` +
    `            <typeValue>${objectApiName}</typeValue>\n` +
    `        </dataTypeMappings>\n` +
    `        <dataTypeMappings>\n` +
    `            <typeName>T__recordsPrior</typeName>\n` +
    `            <typeValue>${objectApiName}</typeValue>\n` +
    `        </dataTypeMappings>\n` +
    `        <inputParameters>\n` +
    `            <name>records</name>\n` +
    `            <value>\n` +
    `                <elementReference>recordCollection</elementReference>\n` +
    `            </value>\n` +
    `        </inputParameters>\n` +
    `        <inputParameters>\n` +
    `            <name>operation</name>\n` +
    `            <value>\n` +
    (event.operationFormula
      ? `                <elementReference>${OPERATION_FORMULA_NAME}</elementReference>\n`
      : `                <stringValue>AFTER_DELETE</stringValue>\n`) +
    `            </value>\n` +
    `        </inputParameters>\n` +
    `        <nameSegment>${actionName}</nameSegment>\n` +
    `    </actionCalls>\n` +
    `    <assignments>\n` +
    `        <name>Collect_Record</name>\n` +
    `        <label>Collect Record</label>\n` +
    `        <locationX>176</locationX>\n` +
    `        <locationY>167</locationY>\n` +
    `        <assignmentItems>\n` +
    `            <assignToReference>recordCollection</assignToReference>\n` +
    `            <operator>Add</operator>\n` +
    `            <value>\n` +
    `                <elementReference>$Record</elementReference>\n` +
    `            </value>\n` +
    `        </assignmentItems>\n` +
    `        <connector>\n` +
    `            <targetReference>Enqueue_Record_Sync</targetReference>\n` +
    `        </connector>\n` +
    `    </assignments>\n` +
    `    <environments>Default</environments>\n` +
    (event.operationFormula
      ? `    <formulas>\n` +
        `        <name>${OPERATION_FORMULA_NAME}</name>\n` +
        `        <dataType>String</dataType>\n` +
        `        <expression>${event.operationFormula}</expression>\n` +
        `    </formulas>\n`
      : '') +
    `    <interviewLabel>${label} {!$Flow.CurrentDateTime}</interviewLabel>\n` +
    `    <label>${label}</label>\n` +
    `    <processType>AutoLaunchedFlow</processType>\n` +
    `    <start>\n` +
    `        <locationX>50</locationX>\n` +
    `        <locationY>0</locationY>\n` +
    `        <connector>\n` +
    `            <targetReference>Collect_Record</targetReference>\n` +
    `        </connector>\n` +
    `        <object>${objectApiName}</object>\n` +
    `        <recordTriggerType>${event.recordTriggerType}</recordTriggerType>\n` +
    `        <triggerType>${event.triggerType}</triggerType>\n` +
    `    </start>\n` +
    `    <status>Active</status>\n` +
    `    <variables>\n` +
    `        <name>recordCollection</name>\n` +
    `        <dataType>SObject</dataType>\n` +
    `        <isCollection>true</isCollection>\n` +
    `        <isInput>false</isInput>\n` +
    `        <isOutput>false</isOutput>\n` +
    `        <objectType>${objectApiName}</objectType>\n` +
    `    </variables>\n` +
    `</Flow>`
  );
};

interface ISalesforceDescribe {
  triggerable?: boolean;
}

const describeObject = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<ISalesforceDescribe> => {
  const { data } = await salesforceRequest<ISalesforceDescribe>(
    {
      url: `${instanceUrl}/services/data/v${API_VERSION}/sobjects/${objectApiName}/describe`,
      method: 'GET',
    },
    tokens
  );
  return data;
};

// ---------------------------------------------------------------------------
// Shared Metadata API deploy — multipart upload of a zip, then poll to done.
//
// Used by every deploy in this file (flow create, permission set grant,
// destructive deletes); only the deployOptions differ.
// ---------------------------------------------------------------------------
interface IDeployResult {
  done: boolean;
  success: boolean;
  status?: string;
  errorMessage?: string;
  details?: {
    componentFailures?: { problem: string; componentType: string; fullName: string }[];
    runTestResult?: {
      failures?: { name: string; methodName: string; message: string }[];
      codeCoverageWarnings?: { name?: string; message: string }[];
    };
  };
}

// Salesforce collapses single-element detail lists into a bare object.
const asArray = <T>(value: T[] | T | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

// A failed deploy reports its reason in one of three unrelated places, and a
// test/coverage failure leaves componentFailures empty — so all of them have to
// be read or the thrown error comes out blank.
const describeDeployFailure = (result: IDeployResult): string => {
  const { details, errorMessage, status } = result;
  const reasons = [
    ...asArray(details?.componentFailures).map((f) => `${f.componentType}:${f.fullName} — ${f.problem}`),
    ...asArray(details?.runTestResult?.failures).map((f) => `test ${f.name}.${f.methodName} — ${f.message}`),
    ...asArray(details?.runTestResult?.codeCoverageWarnings).map((w) => `coverage — ${w.message}`),
  ];
  if (errorMessage) { reasons.push(errorMessage); }
  return reasons.join('; ') || status || 'unknown error';
};

const deployMetadata = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  zip: JSZip,
  deployOptions: Record<string, unknown>,
  label: string
): Promise<void> => {
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  // httpRequest hardcodes application/json — use native fetch for multipart upload.
  const boundary = `----DataVaultBoundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${JSON.stringify({ deployOptions })}\r\n` +
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
    throw new Error(`${label} deploy request failed: ${await deployResponse.text()}`);
  }

  const { id: jobId } = await deployResponse.json() as { id: string };

  // Poll until the deploy job completes (Salesforce deploys are async).
  while (true) {
    await timer(2000);
    const { data } = await salesforceRequest<{ deployResult: IDeployResult }>(
      {
        url: `${instanceUrl}/services/data/v${API_VERSION}/metadata/deployRequest/${jobId}?includeDetails=true`,
        method: 'GET',
      },
      tokens
    );

    if (!data.deployResult.done) { continue; }
    if (!data.deployResult.success) {
      throw new Error(`${label} deploy failed: ${describeDeployFailure(data.deployResult)}`);
    }
    return;
  }
};

// ---------------------------------------------------------------------------
// Destructive Metadata API deploy — the only way to remove components from a
// production org. Tooling API DELETE is rejected there for both Apex
// (DEPENDENCY_EXISTS "Cannot delete classes/triggers in production") and Flows.
//
// Salesforce destructive deploy rules:
//   - destructiveChanges.xml → lists what to delete, one <types> per type
//   - package.xml            → must be EMPTY (version only)
// ---------------------------------------------------------------------------
const destructiveDeploy = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  members: { type: string; name: string }[],
  label: string,
  extraOptions: Record<string, unknown> = {}
): Promise<void> => {
  const byType = new Map<string, string[]>();
  for (const { type, name } of members) {
    byType.set(type, [...(byType.get(type) ?? []), name]);
  }

  const destructiveXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    Array.from(byType.entries())
      .map(([type, names]) =>
        `    <types>\n` +
        names.map((name) => `        <members>${name}</members>\n`).join('') +
        `        <name>${type}</name>\n` +
        `    </types>\n`
      )
      .join('') +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const emptyPackageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const zip = new JSZip();
  zip.file('destructiveChanges.xml', destructiveXml);
  zip.file('package.xml', emptyPackageXml);

  await deployMetadata(
    instanceUrl,
    tokens,
    zip,
    {
      allowMissingFiles: true,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      runAllTests: false,
      singlePackage: true,
      ...extraOptions,
    },
    label
  );
};

// ---------------------------------------------------------------------------
// Deploy this object's two Flows, active, in one shot. Also the activate
// path: redeploying is how a deactivated flow comes back on, since the
// FlowDefinition deploy can only turn versions off.
// ---------------------------------------------------------------------------
const createFlowsForObject = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string,
  flowNames: string[]
): Promise<void> => {
  // Salesforce refuses record-triggered automation on some standard objects
  // (Partner, most Chatter internals). Ask first — failing here beats burning a
  // full deploy round-trip to be told.
  const describe = await describeObject(instanceUrl, tokens, objectApiName);
  if (describe.triggerable === false) {
    throw new Error(`SObject type does not allow record-triggered flows: ${objectApiName}`);
  }

  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    flowNames.map((name) => `        <members>${name}</members>\n`).join('') +
    `        <name>Flow</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const zip = new JSZip();
  flowNames.forEach((flowName, index) => {
    zip.file(`flows/${flowName}.flow-meta.xml`, buildRecordTriggeredFlow(objectApiName, flowName, FLOW_EVENTS[index]));
  });
  zip.file('package.xml', packageXml);

  // No testLevel: the deploy contains no Apex, which is the entire point of
  // moving off triggers — nothing to cover, nothing to run.
  await deployMetadata(
    instanceUrl,
    tokens,
    zip,
    {
      allowMissingFiles: false,
      autoUpdatePackage: false,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      singlePackage: true,
    },
    `Flows for ${objectApiName}`
  );

  // A deploy can succeed and still leave the flows switched off: an org with
  // "Deploy processes and flows as active" disabled downgrades them to Draft.
  // Silently inactive flows mean real-time backup quietly stops capturing
  // records, so this is checked rather than assumed.
  const states = await fetchFlowStates(instanceUrl, tokens, flowNames);
  const inactive = flowNames.filter((name) => !states.get(name));
  if (inactive.length) {
    throw new Error(
      `flows_deployed_inactive:${inactive.join(',')} — the org deployed them as Draft. ` +
      `Enable "Deploy processes and flows as active" in Setup > Process Automation Settings.`
    );
  }

  // Best-effort: surviving legacy automation only causes duplicate syncs, which
  // is not worth failing an otherwise successful flow deploy over.
  try {
    await removeLegacyApexTrigger(instanceUrl, tokens, triggerNameFor(objectApiName));
  } catch (err) {
    console.log(`Error removing legacy Apex trigger for ${objectApiName}:`, err);
  }

  try {
    await deleteFlows(instanceUrl, tokens, legacyFlowNamesFor(objectApiName));
  } catch (err) {
    console.log(`Error removing legacy per-event flows for ${objectApiName}:`, err);
  }
};

// ---------------------------------------------------------------------------
// Legacy cleanup — orgs provisioned before the move to Flows still carry an
// Apex trigger (and its generated test class) under the same DataVault_*_Trigger
// name. Left in place it enqueues a second sync alongside the new Flow, so it is
// removed both when flows are created and when they are deleted.
//
// ponytail: delete this block, its two helpers and the createHash import once no
// org has an Apex-trigger-era config left.
// ---------------------------------------------------------------------------
const APEX_IDENTIFIER_MAX_LENGTH = 40;

const legacyTestClassNameFor = (triggerName: string): string => {
  const preferred = `${triggerName}Test`;
  if (preferred.length <= APEX_IDENTIFIER_MAX_LENGTH) { return preferred; }

  const digest = createHash('sha1').update(triggerName).digest('hex').slice(0, 6);
  const stem = triggerName.slice(0, APEX_IDENTIFIER_MAX_LENGTH - digest.length - '_Test'.length);
  return `${stem}${digest}_Test`;
};

// Returns true when a legacy trigger was found and removed.
const removeLegacyApexTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerName: string
): Promise<boolean> => {
  const { data } = await salesforceRequest<{ totalSize: number }>(
    {
      url: soqlUrl(instanceUrl, `SELECT Id FROM ApexTrigger WHERE Name = '${triggerName}' LIMIT 1`),
      method: 'GET',
    },
    tokens
  );
  if (data.totalSize === 0) { return false; }

  const testClassName = legacyTestClassNameFor(triggerName);
  const testClassId = await fetchApexClassId(instanceUrl, tokens, testClassName);

  // testLevel RunLocalTests: production deploys touching Apex must run tests.
  // Nothing is being added here, so the per-component 75% coverage bar that
  // ruled RunLocalTests out for the old trigger deploys does not apply.
  await destructiveDeploy(
    instanceUrl,
    tokens,
    [
      { type: 'ApexTrigger', name: triggerName },
      ...(testClassId ? [{ type: 'ApexClass', name: testClassName }] : []),
    ],
    `Legacy trigger ${triggerName} delete`,
    { testLevel: 'RunLocalTests' }
  );
  return true;
};

// ---------------------------------------------------------------------------
// Delete an object's Flows. A flow must be inactive before it can be deleted,
// and listing a member without a version suffix removes every version.
// ---------------------------------------------------------------------------
const deleteFlows = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  flowNames: string[]
): Promise<void> => {
  const states = await fetchFlowStates(instanceUrl, tokens, flowNames);
  const present = flowNames.filter((name) => states.has(name));
  if (!present.length) { return; }

  const active = present.filter((name) => states.get(name));
  if (active.length) {
    await deactivateFlows(instanceUrl, tokens, active);
    // The deactivation deploy can report done before the FlowVersion's inactive
    // state is visible org-wide, which surfaces on the very next deploy as
    // "insufficient access rights on cross-reference id" rather than any real
    // permission problem. A short pause avoids racing that propagation.
    await timer(2000);
  }

  const members = present.map((name) => ({ type: 'Flow', name }));
  try {
    await destructiveDeploy(instanceUrl, tokens, members, `Flow delete: ${present.join(', ')}`);
  } catch (err) {
    if (!(err instanceof Error) || !/insufficient access rights on cross-reference id/i.test(err.message)) {
      throw err;
    }
    logger.info(`[trigger-delete] retrying delete after propagation delay: ${present.join(', ')}`);
    await timer(5000);
    await destructiveDeploy(instanceUrl, tokens, members, `Flow delete (retry): ${present.join(', ')}`);
  }
};

// ---------------------------------------------------------------------------
// Grants permission set access after flow creation/activation:
//   1. Handler class access — the Flow's Apex action
//   2. External Credential Principal access
// Mutates the passed results array to set permissionSetStatus on each entry.
// ---------------------------------------------------------------------------
const setupPermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerResults: ITriggerResult[]
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
      withNamespace(EXTERNAL_CREDENTIAL_PRINCIPAL_NAME)
    );

    for (const trigger of triggerResults) {
      if (trigger.status === 'CREATED') { trigger.permissionSetStatus = 'CREATED'; }
    }
  } catch (error) {
    console.log('Error during permission set setup:', error);
    for (const trigger of triggerResults) {
      if (trigger.status === 'CREATED') {
        trigger.permissionSetStatus = 'FAILED';
        trigger.permissionSetError = error instanceof Error ? error.message : String(error);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Ensure the shared handler ApexClass exists — throws if not installed.
// The class ships with the DataVault managed package (namespace: SALESFORCE_NAMESPACE)
// and is what the generated Flows invoke, so a missing package means dead flows.
// ---------------------------------------------------------------------------
const ensureHandlerClass = async (instanceUrl: string, tokens: SalesforceTokens): Promise<string> => {
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string }[] }>(
    {
      url: soqlUrl(instanceUrl, `SELECT Id FROM ApexClass WHERE Name = '${HANDLER_CLASS_NAME}' LIMIT 1`),
      method: 'GET',
    },
    tokens
  );

  if (data.totalSize === 0) {
    throw new Error(
      `handler_class_not_present: ApexClass '${HANDLER_CLASS_NAME}' was not found in this org. ` +
      `Install the DataVault managed package${SALESFORCE_NAMESPACE ? ` (namespace: ${SALESFORCE_NAMESPACE})` : ''} before enabling real-time triggers.`
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
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string }[] }>(
    {
      url: soqlUrl(instanceUrl, `SELECT Id FROM ApexClass WHERE Name = '${className}' LIMIT 1`),
      method: 'GET',
    },
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
          'Grants access to the DataVault handler class and all real-time backup flows created by DataVault.',
      }),
    },
    tokens
  );

  return data.id;
};

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

  await deployMetadata(
    instanceUrl,
    tokens,
    zip,
    {
      allowMissingFiles: false,
      autoUpdatePackage: false,
      checkOnly: false,
      ignoreWarnings: true,
      rollbackOnError: true,
      runAllTests: false,
      singlePackage: true,
    },
    'External credential principal'
  );
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
// Expand the configured objects with their Master-Detail children so a flow
// is created on each child too. Deduped (case-insensitive) — a child reachable
// from two parents gets a single flow. Best-effort: a failed children lookup
// for one object leaves the rest of the list intact.
// ---------------------------------------------------------------------------
const expandWithMasterChildren = async (
  user: IUser,
  objectApiNames: string[]
): Promise<string[]> => {
  const byName = new Map<string, string>(); // lowercased key -> original casing
  for (const name of objectApiNames) byName.set(name.toLowerCase(), name);

  await Promise.all(
    objectApiNames.map(async (name) => {
      try {
        const childNames = await getMasterChildApiNames(user, name, 'realtime');
        for (const child of childNames) {
          const key = child.toLowerCase();
          if (!byName.has(key)) byName.set(key, child);
        }
      } catch (err) {
        console.log(`Error fetching master children for ${name}:`, err);
      }
    })
  );

  return Array.from(byName.values());
};

// ---------------------------------------------------------------------------
// Create real-time flows for one or more objects sequentially.
// Handler class is ensured once before all flow creations.
// ---------------------------------------------------------------------------
const createTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiNames: string[]
): Promise<ITriggerResult[]> => {
  await ensureHandlerClass(instanceUrl, tokens);

  const results: ITriggerResult[] = [];

  for (let i = 0; i < objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const flowNames = flowNamesFor(objectApiName);
    try {
      const states = await fetchFlowStates(instanceUrl, tokens, flowNames);
      if (flowNames.every((name) => states.get(name))) {
        results.push({ objectApiName, flowNames, status: 'EXIST' });
        continue;
      }
      await createFlowsForObject(instanceUrl, tokens, objectApiName, flowNames);
      results.push({ objectApiName, flowNames, status: 'CREATED' });
      await timer(500);
    } catch (err) {
      console.log(`Error creating flows for ${objectApiName}:`, err);
      results.push({ objectApiName, flowNames, status: 'FAILED', error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    await setupPermissionSet(instanceUrl, tokens, results);
  } catch (error) {
    console.error('Error setting up permission set:', error);
  }
  return results;
};

// ---------------------------------------------------------------------------
// Shared toggle — sets every object's flows to the requested state.
// ACTIVE  : creates the flows if absent, otherwise activates the latest version.
// INACTIVE: skips (NOT_FOUND) if the flows never existed, otherwise deactivates.
// ---------------------------------------------------------------------------
const toggleTriggerStatus = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  config: IBackupConfig,
  targetStatus: 'Active' | 'Inactive'
): Promise<ITriggerResult[]> => {
  if (targetStatus === 'Active') {
    await ensureHandlerClass(instanceUrl, tokens);
  }

  if (!config.triggerResults?.length) {
    return [{ objectApiName: 'N/A', flowNames: [], status: 'NOT_FOUND', error: 'No objects specified in backup config.' }];
  }

  const triggerResults = config.triggerResults;

  for (let i = 0; i < triggerResults.length; i++) {
    const triggerResult = triggerResults[i];
    const objectApiName = objectApiNameOf(config, triggerResult);
    const flowNames = flowNamesFor(objectApiName);
    // Migrates configs written in the Apex-trigger shape onto the current one.
    triggerResult.objectApiName = objectApiName;
    triggerResult.flowNames = flowNames;
    delete triggerResult.triggerName;
    try {
      const states = await fetchFlowStates(instanceUrl, tokens, flowNames);

      if (targetStatus === 'Active') {
        // Redeploy covers both "never existed" and "exists but switched off" —
        // deploying the flow active is the only Metadata API way back on.
        if (flowNames.every((name) => states.get(name))) {
          triggerResult.status = 'EXIST';
        } else {
          await createFlowsForObject(instanceUrl, tokens, objectApiName, flowNames);
          triggerResult.status = 'CREATED';
          await timer(500);
        }
      } else {
        const active = flowNames.filter((name) => states.get(name));
        if (!states.size) {
          triggerResult.status = 'NOT_FOUND';
        } else {
          if (active.length) {
            await deactivateFlows(instanceUrl, tokens, active);
          }
          triggerResult.status = 'INACTIVE';
        }
      }
    } catch (err) {
      const label = targetStatus === 'Active' ? 'activating' : 'inactivating';
      console.log(`Error ${label} flows for ${objectApiName}:`, err);
      triggerResult.status = targetStatus === 'Active' ? 'FAILED' : 'INACTIVATE_FAILED';
      triggerResult.error = err instanceof Error ? err.message : String(err);
    }
  }

  if (targetStatus === 'Active') {
    await setupPermissionSet(instanceUrl, tokens, triggerResults);
  }

  return triggerResults;
};

// ---------------------------------------------------------------------------
// Delete the DataVaultRealTimeTriggerAccess permission set via Metadata API deploy.
// Called after all flows are deleted so the permission set is cleaned up too.
// No-op if the permission set doesn't exist.
// ---------------------------------------------------------------------------
const deletePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<void> => {
  const existing = await fetchPermissionSetId(instanceUrl, tokens);
  if (!existing) { return; }

  await destructiveDeploy(
    instanceUrl,
    tokens,
    [{ type: 'PermissionSet', name: PERMISSION_SET_NAME }],
    'Permission set delete'
  );
};

// ---------------------------------------------------------------------------
// Delete flows — permanently removes an object's real-time automation.
// After all flows are deleted, the permission set is also deleted.
// No-op for objects whose flows don't exist.
// ---------------------------------------------------------------------------
const deleteTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  config: IBackupConfig
): Promise<ITriggerResult[]> => {
  // triggerResults is bookkeeping, not the source of truth — it can be empty or
  // stale (e.g. the post-response write that persists it after creation never
  // landed) while the org still has live flows. Fall back to objectNames, whose
  // flow names are always derivable, so cleanup isn't skipped just because the
  // tracking record is missing.
  const triggerResults: ITriggerResult[] = config.triggerResults?.length
    ? config.triggerResults
    : (config.objectNames ?? []).map((objectApiName) => ({
        objectApiName,
        flowNames: flowNamesFor(objectApiName),
        status: 'CREATED' as const,
      }));

  if (!triggerResults.length) {
    return [{ objectApiName: 'N/A', flowNames: [], status: 'NOT_FOUND', error: 'No objects specified in backup config.' }];
  }

  for (let i = 0; i < triggerResults.length; i++) {
    const triggerResult = triggerResults[i];
    const objectApiName = objectApiNameOf(config, triggerResult);

    triggerResult.objectApiName = objectApiName;
    delete triggerResult.triggerName;

    // No status gate: fetchFlowStates + deleteFlows are already no-ops when the
    // org has nothing under these names, so attempting delete regardless of the
    // last recorded status is what catches the case that status has drifted
    // from what's actually deployed.
    try {
      // Union of what this config recorded, what the current naming produces and
      // the retired three-flow names — deleteFlows filters to what the org
      // actually has, so an over-wide list costs nothing and an under-wide one
      // strands an active flow that keeps syncing a deleted config.
      const flowNames = Array.from(new Set([
        ...(triggerResult.flowNames ?? []),
        ...flowNamesFor(objectApiName),
        ...legacyFlowNamesFor(objectApiName),
      ]));
      triggerResult.flowNames = flowNames;
      const states = await fetchFlowStates(instanceUrl, tokens, flowNames);
      const legacyRemoved = await removeLegacyApexTrigger(instanceUrl, tokens, triggerNameFor(objectApiName));

      if (states.size === 0) {
        triggerResult.status = legacyRemoved ? 'DELETED' : 'NOT_FOUND';
        logger.info(`[trigger-delete] ${objectApiName}: no flows found in org (status=${triggerResult.status}${legacyRemoved ? ', legacy Apex trigger removed' : ''})`);
        continue;
      }

      await deleteFlows(instanceUrl, tokens, flowNames);

      triggerResult.status = 'DELETED';
      logger.info(`[trigger-delete] ${objectApiName}: deleted flows [${flowNames.join(', ')}]`);
    } catch (err) {
      triggerResult.status = 'DELETE_FAILED';
      triggerResult.error = err instanceof Error ? err.message : String(err);
      logger.error(`[trigger-delete] ${objectApiName}: failed — ${triggerResult.error}`);
    }
  }

  // Delete the permission set after all flows are removed.
  try {
    await deletePermissionSet(instanceUrl, tokens);
    logger.info(`[trigger-delete] permission set '${PERMISSION_SET_NAME}' deleted`);
  } catch (err) {
    logger.error(`[trigger-delete] failed to delete permission set: ${err instanceof Error ? err.message : String(err)}`);
  }

  const deleted = triggerResults.filter((r) => r.status === 'DELETED').length;
  const failed = triggerResults.filter((r) => r.status === 'DELETE_FAILED').length;
  logger.info(
    `[trigger-delete] backupConfigId=${config.backupConfigId} done: ${deleted}/${triggerResults.length} deleted, ${failed} failed — ` +
    triggerResults.map((r) => `${r.objectApiName}=${r.status}`).join(', ')
  );

  return triggerResults;
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
  try {

    const user = await getUser({ userId: config.userId });
    if (!user || !user.crmId) {
      throw new Error('User not found');
    }

    const crm = await getCrmById(user.crmId);
    if (!crm) { throw new Error(`crm_not_found:${config.crmId}`); }

    const instanceUrl = user.crmProfile?.instanceUrl;
    if (!instanceUrl) { throw new Error(`instance_url_missing:${config.crmId}`); }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      userId: user.userId,
      environment: crm.environment,
      customUrl: user.customUrl,
    };

    const objectApiNames = config.objectNames;

    if (operation === 'create') {
      // const expandedNames = await expandWithMasterChildren(user, objectApiNames);
      // // Children get a flow, so they get backed up — record them on the config
      // // too, otherwise every config-driven reader (Glue, restore listing, UI) stays
      // // blind to data that is already landing in S3 under the child's own name.
      // await appendObjectsToBackupConfig(config.backupConfigId, expandedNames);
      return createTriggers(instanceUrl, tokens, objectApiNames);
    }
    if (operation === 'activate') { return toggleTriggerStatus(instanceUrl, tokens, config, 'Active'); }
    if (operation === 'inactivate') { return toggleTriggerStatus(instanceUrl, tokens, config, 'Inactive'); }
    if (operation === 'delete') { return deleteTriggers(instanceUrl, tokens, config); }
    throw new Error(`invalid_operation:${operation}`);
  } catch (error) {
    console.log(`Error during trigger ${operation}:`, error);
    return [{
      objectApiName: 'N/A',
      flowNames: [],
      status: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    }];
  }
};

export {
  createTriggers,
  toggleTriggerStatus,
  deleteTriggers,
  deletePermissionSet,
  realTimeTriggerManagement,
  triggerNameFor,
  flowNamesFor,
};
