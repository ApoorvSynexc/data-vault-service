import JSZip from 'jszip';
import { createHash } from 'crypto';
import { salesforceRequest, SalesforceTokens } from './index';
import { IBackupConfig, IUser } from '../../../models';
import { getCrmById } from '../../crm';
import { appendObjectsToBackupConfig } from '../../backup-config';
import { getUser } from '../../user';
import { timer } from '../../../utils/helper';
import { decrypt } from '../../../utils/encryption';
import { getMasterChildApiNames } from './apex';
import { SCHEDULE_MODE } from '../../../constant';

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
const triggerNameFor = (objectApiName: string): string =>
  `DataVault_${objectApiName.replace('__c', '')}_Trigger`;

// Apex class and trigger names are capped at 40 characters. Objects with long
// API names (AccountContactRelation, CollaborationGroupRecord) push the test
// class past it, so the name is truncated and given a short digest of the
// trigger name to keep it unique — two truncated names must not collide.
const APEX_IDENTIFIER_MAX_LENGTH = 40;

const testClassNameFor = (triggerName: string): string => {
  const preferred = `${triggerName}Test`;
  if (preferred.length <= APEX_IDENTIFIER_MAX_LENGTH) { return preferred; }

  const digest = createHash('sha1').update(triggerName).digest('hex').slice(0, 6);
  const stem = triggerName.slice(0, APEX_IDENTIFIER_MAX_LENGTH - digest.length - '_Test'.length);
  return `${stem}${digest}_Test`;
};

const buildTriggerBody = (objectApiName: string): string => {
  const triggerName = triggerNameFor(objectApiName);
  return (
    `trigger ${triggerName} on ${objectApiName} (after insert, after update, after delete, after undelete) {\n` +
    `    // The call, try and catch are deliberately on ONE line. Apex code coverage\n` +
    `    // is line-based, and a 'catch' clause on its own line is a countable line\n` +
    `    // that no passing test can reach — split across lines this trigger measures\n` +
    `    // 66.667% and Salesforce rejects the deploy below 75%. On one line it is a\n` +
    `    // single covered line. Do not reformat, and do not add a statement inside\n` +
    `    // the catch. The catch itself must stay: a real-time backup must never make\n` +
    `    // the user's own DML fail. Errors are reported by the handler, which\n` +
    `    // notifies on failure.\n` +
    `    try { ${NAMESPACE_PREFIX}.${HANDLER_CLASS_NAME}.enqueueSync(Trigger.new, Trigger.old, Trigger.operationType.name()); } catch (Exception e) {}\n` +
    `}`
  );
};

// ---------------------------------------------------------------------------
// Test class generation.
//
// Salesforce requires each deployed trigger to reach 75% coverage, and a
// managed package's own tests do not count towards subscriber-org coverage, so
// coverage has to ship with the trigger. Firing the trigger means inserting a
// record, and which fields that needs differs per object and per org.
//
// That lookup happens here in Node against the standard describe endpoint, so
// the generated Apex stays a plain, readable test class with concrete field
// values rather than runtime reflection.
// ---------------------------------------------------------------------------
interface ISalesforceField {
  name: string;
  type: string;
  createable: boolean;
  nillable: boolean;
  defaultedOnCreate: boolean;
  autoNumber: boolean;
  length?: number;
  referenceTo?: string[];
  picklistValues?: { value: string; active: boolean }[];
}

// One level of parents (child → parent → grandparent). Also bounds self-
// referencing lookups such as Account.ParentId.
const MAX_PARENT_DEPTH = 2;

const TEST_TEXT_VALUE = 'DataVault Test';

interface ISalesforceDescribe {
  triggerable?: boolean;
  fields?: ISalesforceField[];
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

// SObject names are qualified with the Schema namespace because several of them
// collide with built-in Apex types — `Location` resolves to System.Location (the
// compound geolocation type), not the SObject, so `new Location(...)` fails to
// compile. Schema.Location is unambiguous, and the prefix is valid for every
// SObject, so it is applied uniformly rather than against a list of known
// collisions that would need maintaining.
const apexSObjectType = (objectApiName: string): string => `Schema.${objectApiName}`;

// Populate a field only when it is writable, has no default, and rejects null.
// Auto-number fields report as non-nillable but are assigned by the org.
const isRequiredOnCreate = (field: ISalesforceField): boolean =>
  field.createable && !field.nillable && !field.defaultedOnCreate && !field.autoNumber;

const apexStringLiteral = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const apexLiteralFor = (field: ISalesforceField): string | null => {
  switch (field.type) {
    case 'string':
    case 'textarea':
    case 'encryptedstring':
    case 'combobox':
      return apexStringLiteral(
        field.length && field.length > 0 ? TEST_TEXT_VALUE.slice(0, field.length) : TEST_TEXT_VALUE
      );
    case 'picklist':
    case 'multipicklist': {
      const entry = field.picklistValues?.find((value) => value.active);
      return entry ? apexStringLiteral(entry.value) : null;
    }
    case 'email': return apexStringLiteral('datavault.test@example.invalid');
    case 'phone': return apexStringLiteral('5555555555');
    case 'url': return apexStringLiteral('https://example.invalid');
    case 'int': return '1';
    case 'double': case 'currency': case 'percent': return '1.0';
    case 'date': return 'Date.today()';
    case 'datetime': return 'System.now()';
    case 'time': return 'Time.newInstance(0, 0, 0, 0)';
    case 'boolean': return 'false';
    default: return null;
  }
};

const formatConstructorArgs = (assignments: string[]): string =>
  assignments.length === 0 ? '' : `\n            ${assignments.join(',\n            ')}\n        `;

// Returns the constructor assignments for one record, appending any parent
// declarations it needs to `parentLines` first — deepest parent emitted first,
// so the generated statements are already in insertable order.
const buildRecordAssignments = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string,
  depth: number,
  seq: { next: number },
  parentLines: string[],
  rootFields?: ISalesforceField[]
): Promise<string[]> => {
  const fields = rootFields ?? (await describeObject(instanceUrl, tokens, objectApiName)).fields ?? [];
  const assignments: string[] = [];

  for (const field of fields.filter(isRequiredOnCreate)) {
    if (field.type !== 'reference') {
      const literal = apexLiteralFor(field);
      if (literal) { assignments.push(`${field.name} = ${literal}`); }
      continue;
    }

    const parentObject = field.referenceTo?.[0];
    if (!parentObject || depth >= MAX_PARENT_DEPTH) { continue; }

    const parentVar = `parent${seq.next++}`;
    const parentAssignments = await buildRecordAssignments(
      instanceUrl, tokens, parentObject, depth + 1, seq, parentLines
    );
    const parentType = apexSObjectType(parentObject);
    parentLines.push(
      `        ${parentType} ${parentVar} = new ${parentType}(${formatConstructorArgs(parentAssignments)});`,
      `        insert ${parentVar};`,
      ''
    );
    assignments.push(`${field.name} = ${parentVar}.Id`);
  }

  return assignments;
};

// One insert is enough: the trigger body is a single statement shared by all
// four DML events, so `after insert` alone covers 100% of it.
const buildTriggerTestBody = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string,
  testClassName: string,
  triggerName: string,
  rootFields: ISalesforceField[]
): Promise<string> => {
  const parentLines: string[] = [];
  const assignments = await buildRecordAssignments(
    instanceUrl, tokens, objectApiName, 0, { next: 1 }, parentLines, rootFields
  );
  const recordType = apexSObjectType(objectApiName);

  return (
    `@isTest\n` +
    `private class ${testClassName} {\n` +
    `\n` +
    `    @isTest\n` +
    `    static void syncTriggerFiresOnInsert() {\n` +
    parentLines.join('\n') + (parentLines.length ? '\n' : '') +
    `        ${recordType} record = new ${recordType}(${formatConstructorArgs(assignments)});\n` +
    `\n` +
    `        Test.startTest();\n` +
    `        insert record;\n` +
    `        Test.stopTest();\n` +
    `\n` +
    `        Assert.isNotNull(\n` +
    `            record.Id,\n` +
    `            'Insert of ${objectApiName} should succeed and fire ${triggerName}.'\n` +
    `        );\n` +
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
// Shared Metadata API deploy — multipart upload of a zip, then poll to done.
//
// Used by every deploy in this file (trigger create, permission set grant,
// permission set delete); only the deployOptions differ.
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
// Creates a single trigger via Metadata API deploy — shared by createTriggers
// and activateTriggers.
//
// Salesforce blocks direct Tooling API POST /sobjects/ApexTrigger in active
// (production) orgs — "Can not create Apex Trigger on an active organization"
// (ENTITY_IS_LOCKED). Apex code creation must instead go through a Metadata
// API deploy of a triggers/*.trigger + *.trigger-meta.xml pair, the same
// container-deploy workflow already used below for the permission set.
// Production deploys containing Apex also require a testLevel other than
// NoTestRun, so RunLocalTests is specified explicitly.
// ---------------------------------------------------------------------------
const createSingleTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string
): Promise<void> => {
  const triggerName = triggerNameFor(objectApiName);
  const testClassName = testClassNameFor(triggerName);

  // Salesforce rejects triggers on some standard objects (Partner, and most
  // Chatter internals). Ask first — the describe is needed for the test class
  // anyway, and failing here beats burning a full deploy round-trip to be told.
  const describe = await describeObject(instanceUrl, tokens, objectApiName);
  if (describe.triggerable === false) {
    throw new Error(`SObject type does not allow triggers: ${objectApiName}`);
  }

  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    `        <members>${triggerName}</members>\n` +
    `        <name>ApexTrigger</name>\n` +
    `    </types>\n` +
    `    <types>\n` +
    `        <members>${testClassName}</members>\n` +
    `        <name>ApexClass</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const triggerMetaXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <apiVersion>${API_VERSION}</apiVersion>\n` +
    `    <status>Active</status>\n` +
    `</ApexTrigger>`;

  const classMetaXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <apiVersion>${API_VERSION}</apiVersion>\n` +
    `    <status>Active</status>\n` +
    `</ApexClass>`;

  const zip = new JSZip();
  zip.file(`triggers/${triggerName}.trigger`, buildTriggerBody(objectApiName));
  zip.file(`triggers/${triggerName}.trigger-meta.xml`, triggerMetaXml);
  zip.file(
    `classes/${testClassName}.cls`,
    await buildTriggerTestBody(
      instanceUrl, tokens, objectApiName, testClassName, triggerName, describe.fields ?? []
    )
  );
  zip.file(`classes/${testClassName}.cls-meta.xml`, classMetaXml);
  zip.file('package.xml', packageXml);

  // RunSpecifiedTests, not RunLocalTests: RunLocalTests enforces the org-wide
  // 75% average across ALL local Apex, which a subscriber org with its own
  // uncovered code can never satisfy no matter what we ship. RunSpecifiedTests
  // applies the 75% bar per deployed component instead, so only this trigger
  // has to be covered — and running just our own test also stops unrelated
  // failing tests in the subscriber org from blocking the deploy.
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
      testLevel: 'RunSpecifiedTests',
      runTests: [testClassName],
    },
    `Trigger ${triggerName}`
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
      EXTERNAL_CREDENTIAL_PRINCIPAL_NAME
    );

    for (const trigger of triggerResults) {
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
// Expand the configured objects with their Master-Detail children so a trigger
// is created on each child too. Deduped (case-insensitive) — a child reachable
// from two parents gets a single trigger. Best-effort: a failed children lookup
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
        const childNames = await getMasterChildApiNames(user, name, SCHEDULE_MODE.realtime);
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

  for (let i = 0; i < objectApiNames.length; i++) {
    const objectApiName = objectApiNames[i];
    const triggerName = triggerNameFor(objectApiName);
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

  try {
    await setupPermissionSet(instanceUrl, tokens, results);
  } catch (error) {
    console.error('Error setting up permission set:', error);
  }
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
  config: IBackupConfig,
  targetStatus: 'Active' | 'Inactive'
): Promise<ITriggerResult[]> => {
  if (targetStatus === 'Active') {
    await ensureHandlerClass(instanceUrl, tokens);
  }

  const results: ITriggerResult[] = [];
  if (!config.triggerResults?.length) {
    results.push({ triggerName: 'N/A', status: 'NOT_FOUND', error: 'No objects specified in backup config.' });
    return results;
  }

  const triggerResults = config.triggerResults;

  for (let i = 0; i < triggerResults.length; i++) {
    const triggerResult = triggerResults[i];
    const triggerName = triggerResult.triggerName;
    const objectApiName = triggerName.replace('DataVault_', '').replace('_Trigger', '');
    try {
      const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);

      if (targetStatus === 'Active') {
        if (!trigger) {
          await createSingleTrigger(instanceUrl, tokens, objectApiName);
          triggerResult.status = 'CREATED';
          await timer(500);
        } else if (trigger.Status === 'Active') {
          triggerResult.status = 'EXIST';
        } else {
          await patchTriggerStatus(instanceUrl, tokens, trigger.Id, 'Active');
          triggerResult.status = 'CREATED';
        }
      } else {
        if (!trigger) {
          triggerResult.status = 'NOT_FOUND';
        } else if (trigger.Status === 'Inactive') {
          triggerResult.status = 'INACTIVE';
        } else {
          await patchTriggerStatus(instanceUrl, tokens, trigger.Id, 'Inactive');
          triggerResult.status = 'INACTIVE';
        }
      }
    } catch (err) {
      const label = targetStatus === 'Active' ? 'activating' : 'inactivating';
      console.log(`Error ${label} trigger ${triggerName}:`, err);
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
// Called after all triggers are deleted so the permission set is cleaned up too.
// No-op if the permission set doesn't exist.
// ---------------------------------------------------------------------------
const deletePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<void> => {
  const existing = await fetchPermissionSetId(instanceUrl, tokens);
  if (!existing) { return; }

  // Salesforce destructive deploy rules:
  //   - destructiveChanges.xml  → lists what to delete
  //   - package.xml             → must be EMPTY (only version), no types/members
  const emptyPackageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
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
    },
    'Permission set delete'
  );
};

// ---------------------------------------------------------------------------
// Delete triggers — permanently removes the trigger from the org.
// After all triggers are deleted, the permission set is also deleted.
// No-op for objects whose trigger doesn't exist.
// ---------------------------------------------------------------------------
const deleteTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  config: IBackupConfig
): Promise<ITriggerResult[]> => {
  if (!config.triggerResults?.length) {
    return [{ triggerName: 'N/A', status: 'NOT_FOUND', error: 'No objects specified in backup config.' }];
  }

  const triggerResults = config.triggerResults;
  for (let i = 0; i < triggerResults.length; i++) {
    const triggerResult = triggerResults[i];
    const triggerName = triggerResult.triggerName;
    const status = triggerResult.status;

    if (!['CREATED', 'INACTIVE', 'EXIST'].includes(status)) continue;
    try {
      const trigger = await fetchTrigger(instanceUrl, tokens, triggerName);
      if (!trigger) {
        triggerResult.status = 'NOT_FOUND';
        continue;
      }

      await salesforceRequest(
        { url: `${TOOLING_BASE(instanceUrl)}/sobjects/ApexTrigger/${trigger.Id}`, method: 'DELETE' },
        tokens
      );

      triggerResult.status = 'DELETED';
    } catch (err) {
      triggerResult.status = 'DELETE_FAILED';
      triggerResult.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Delete the permission set after all triggers are removed.
  try {
    await deletePermissionSet(instanceUrl, tokens);
  } catch (err) {
    console.log('Error deleting permission set:', err);
  }

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

  const { access_token, refresh_token } = user.crmCredential ? JSON.parse(decrypt(user.crmCredential)) : {};
    const tokens: SalesforceTokens = {
      accessToken: access_token,
      refreshToken: refresh_token,
      userId: user.userId,
      environment: crm.environment,
      customUrl: user.customUrl,
    };

    const objectApiNames = config.objectNames;

    if (operation === 'create') {
      const expandedNames = await expandWithMasterChildren(user, objectApiNames);
      // Children get a trigger, so they get backed up — record them on the config
      // too, otherwise every config-driven reader (Glue, restore listing, UI) stays
      // blind to data that is already landing in S3 under the child's own name.
      await appendObjectsToBackupConfig(config.backupConfigId, expandedNames);
      return createTriggers(instanceUrl, tokens, expandedNames);
    }
    if (operation === 'activate') { return toggleTriggerStatus(instanceUrl, tokens, config, 'Active'); }
    if (operation === 'inactivate') { return toggleTriggerStatus(instanceUrl, tokens, config, 'Inactive'); }
    if (operation === 'delete') { return deleteTriggers(instanceUrl, tokens, config); }
    throw new Error(`invalid_operation:${operation}`);
  } catch (error) {
    console.log(`Error during trigger ${operation}:`, error);
    return [{
      triggerName: 'N/A',
      status: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    }];
  }
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
