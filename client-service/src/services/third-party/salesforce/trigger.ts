import JSZip from 'jszip';
import { createHash } from 'crypto';
import { salesforceRequest, SalesforceTokens } from './index';
import { IBackupConfig, ITriggerResult, IUser } from '../../../models';
import { getCrmById } from '../../crm';
import { appendObjectsToBackupConfig, getBackupConfigsByCrm } from '../../backup-config';
import { getUser, getDecryptedCrmCredential } from '../../user';
import { timer } from '../../../utils/helper';
import { getMasterChildApiNames } from './apex';
import { METADATA_API_VERSION as API_VERSION } from './metadata-api';
import { withNamespace } from '../../../utils/salesforce-namespace';
import {
  SALESFORCE_NAMESPACE,
  SCHEDULE_MODE,
  SALESFORCE_PERMISSION_SET_APEX_CLASSES,
  SALESFORCE_EXTERNAL_CREDENTIAL_PRINCIPAL,
  SALESFORCE_HANDLER_CLASS_NAME,
  SALESFORCE_HANDLER_METHOD_NAME,
} from '../../../constant';
import { logger } from '../../../middlewares';

const HANDLER_CLASS_NAME = SALESFORCE_HANDLER_CLASS_NAME;

// ---------------------------------------------------------------------------
// Real-time sync is delivered by an Apex Trigger per object, calling the
// managed package's handler class/method (SALESFORCE_HANDLER_CLASS_NAME /
// SALESFORCE_HANDLER_METHOD_NAME, default DataVaultRecordSyncTriggerHandler.
// enqueueSync). Salesforce requires each deployed trigger to reach 75% coverage, and a managed
// package's own tests do not count towards subscriber-org coverage, so every
// trigger ships with a generated Test Class (see createSingleTrigger below).
// ---------------------------------------------------------------------------
const triggerNameFor = (objectApiName: string): string =>
  `DataVault_${objectApiName.replace('__c', '')}_Trigger`;

// Older configs (written before this file briefly moved real-time sync onto
// Flows) may only have `triggerName` stored, not `objectApiName`. Recover the
// exact SObject API name from the config's own objectNames, falling back to
// undoing the string surgery.
const objectApiNameOf = (config: IBackupConfig, result: ITriggerResult): string =>
  result.objectApiName ??
  (config.objectNames ?? []).find((name) => triggerNameFor(name) === result.triggerName) ??
  String(result.triggerName).replace('DataVault_', '').replace('_Trigger', '');

// testClassNameFor is deterministic today, but the stored value is what's
// actually deployed in the org — preferring it (falling back to recompute for
// older records saved before this was tracked) means a future change to the
// naming/truncation rule can't orphan an already-deployed class.
const testClassNameOf = (triggerName: string, result: ITriggerResult): string =>
  result.testClassName ?? testClassNameFor(triggerName);

// ---------------------------------------------------------------------------
// Production orgs reject the Tooling API for writing Apex (both POST create
// and PATCH status) — every create, status change and delete in this file
// goes through a Metadata API deploy instead, which is the only route
// supported for Apex in production. Reads go through the standard Data API,
// where ApexClass and ApexTrigger are both queryable.
// ---------------------------------------------------------------------------
const soqlUrl = (instanceUrl: string, soql: string): string =>
  `${instanceUrl}/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`;

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

// ---------------------------------------------------------------------------
// Apex Trigger + Test Class generation (real-time trigger creation only).
//
// Salesforce requires each deployed trigger to reach 75% coverage, and a
// managed package's own tests do not count towards subscriber-org coverage, so
// coverage has to ship with the trigger — firing it means inserting a record,
// and which fields that needs differs per object and per org. That lookup
// happens here in Node against the standard describe endpoint, so the
// generated Apex stays a plain, readable test class with concrete field
// values rather than runtime reflection. `SeeAllData=true` on the class is
// additional — it lets the test read existing org data the trigger logic may
// depend on, it does not by itself satisfy the coverage requirement.
// ---------------------------------------------------------------------------

// One level of parents (child → parent → grandparent). Also bounds self-
// referencing lookups such as Account.ParentId.
const MAX_PARENT_DEPTH = 2;

const TEST_TEXT_VALUE = 'DataVault Test';

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

// The Apex reference to the handler class from generated trigger/test code —
// dot-qualified (SYX_DVV.ClassName), unlike the metadata API's double-underscore
// form (SYX_DVV__ComponentName) that withNamespace produces elsewhere in this
// file (e.g. the External Credential Principal name in setupPermissionSet).
const apexHandlerRef = SALESFORCE_NAMESPACE ? `${SALESFORCE_NAMESPACE}.${HANDLER_CLASS_NAME}` : HANDLER_CLASS_NAME;

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
    `    try { ${apexHandlerRef}.${SALESFORCE_HANDLER_METHOD_NAME}(Trigger.new, Trigger.old, Trigger.operationType.name()); } catch (Exception e) {}\n` +
    `}`
  );
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
    // SeeAllData=true so the test can read existing org data (config records,
    // setup data) the trigger's logic may depend on — separate from, and no
    // substitute for, the synthetic insert below that earns the 75% coverage.
    `@isTest(SeeAllData=true)\n` +
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
// Shared Metadata API deploy — multipart upload of a zip, then poll to done.
//
// Used by every deploy in this file (trigger create, status toggle, permission
// set grant, destructive deletes); only the deployOptions differ.
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
// production org. Tooling API DELETE is rejected there for Apex
// (DEPENDENCY_EXISTS "Cannot delete classes/triggers in production").
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
// Look up an existing Apex Trigger by name — used by createTriggers to skip
// re-creating an already-active trigger.
// ---------------------------------------------------------------------------
const fetchApexTriggerStatus = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerName: string
): Promise<{ Id: string; Status: string } | null> => {
  const { data } = await salesforceRequest<{ totalSize: number; records: { Id: string; Status: string }[] }>(
    { url: soqlUrl(instanceUrl, `SELECT Id, Status FROM ApexTrigger WHERE Name = '${triggerName}' LIMIT 1`), method: 'GET' },
    tokens
  );
  return data.totalSize > 0 ? data.records[0] : null;
};

// ---------------------------------------------------------------------------
// Shared deploy — the Apex Trigger body (always buildTriggerBody's
// deterministic output) plus a caller-supplied Test Class body, both Active.
// The only route available for creating/replacing Apex in production: direct
// Tooling API POST /sobjects/ApexTrigger is blocked there (ENTITY_IS_LOCKED),
// and any deploy containing Apex requires a testLevel other than NoTestRun.
//
// RunSpecifiedTests, not RunLocalTests: RunLocalTests enforces the org-wide
// 75% average across ALL local Apex, which a subscriber org with its own
// uncovered code can never satisfy no matter what we ship. RunSpecifiedTests
// applies the 75% bar per deployed component instead, so only this trigger
// has to be covered — and running just our own test also stops unrelated
// failing tests in the subscriber org from blocking the deploy.
// ---------------------------------------------------------------------------
const deployTriggerWithTestClass = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string,
  testClassBody: string,
  label: string
): Promise<void> => {
  const triggerName = triggerNameFor(objectApiName);
  const testClassName = testClassNameFor(triggerName);

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
  zip.file(`classes/${testClassName}.cls`, testClassBody);
  zip.file(`classes/${testClassName}.cls-meta.xml`, classMetaXml);
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
      testLevel: 'RunSpecifiedTests',
      runTests: [testClassName],
    },
    label
  );
};

// ---------------------------------------------------------------------------
// Creates a single Apex Trigger + its generated Test Class. The test class
// inserts a synthetic record built from the object's describe metadata (see
// buildTriggerTestBody) — this is what can fail recoverTriggerCreation is for:
// a validation rule, duplicate rule, or required dependency the describe
// metadata doesn't capture can reject the synthetic insert even though the
// trigger itself is fine.
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

  const testClassBody = await buildTriggerTestBody(
    instanceUrl, tokens, objectApiName, testClassName, triggerName, describe.fields ?? []
  );

  await deployTriggerWithTestClass(instanceUrl, tokens, objectApiName, testClassBody, `Trigger ${triggerName}`);
};

// A Salesforce record Id is exactly 15 (case-sensitive) or 18 (case-insensitive)
// alphanumeric characters — validated before this ever reaches generated Apex
// source, since recordId is user-supplied and gets embedded in a SOQL literal
// that gets compiled and deployed to the org.
const SALESFORCE_RECORD_ID_PATTERN = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

// ---------------------------------------------------------------------------
// Recovery test class for when createSingleTrigger's synthetic insert fails:
// instead of constructing a new record from describe metadata, this queries
// an existing, already-valid record the user points to (by its record Id, not
// a trigger/class Id — there's nothing else the user could have at this point)
// and re-saves it unchanged. A no-op `update` on a record that already passed
// every validation/duplicate rule on the way in is about as safe as a DML
// statement gets, and it still fires the trigger for coverage.
// ---------------------------------------------------------------------------
const buildTriggerRecoveryTestBody = (
  objectApiName: string,
  testClassName: string,
  triggerName: string,
  recordId: string
): string => {
  const recordType = apexSObjectType(objectApiName);

  return (
    `@isTest(SeeAllData=true)\n` +
    `private class ${testClassName} {\n` +
    `\n` +
    `    @isTest\n` +
    `    static void syncTriggerFiresOnUpdate() {\n` +
    `        ${recordType} record = [SELECT Id FROM ${objectApiName} WHERE Id = '${recordId}' LIMIT 1];\n` +
    `\n` +
    `        Test.startTest();\n` +
    `        update record;\n` +
    `        Test.stopTest();\n` +
    `\n` +
    `        Assert.isNotNull(\n` +
    `            record.Id,\n` +
    `            'Update of existing ${objectApiName} record should succeed and fire ${triggerName}.'\n` +
    `        );\n` +
    `    }\n` +
    `}`
  );
};

// ---------------------------------------------------------------------------
// Recovery path when createSingleTrigger fails even with the SeeAllData test
// class: the caller collects a real record Id of `objectApiName` from the
// user (not a Trigger/Class Id — the user has no way to know one of those)
// and this confirms that record exists in the org, then redeploys the trigger
// with a test class built around it (buildTriggerRecoveryTestBody) instead of
// a synthetic insert. Throws if the Id is malformed, the record can't be
// found, or the deploy itself fails; the controller is expected to tell the
// user to contact Support at that point.
// ---------------------------------------------------------------------------
const recoverTriggerCreation = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string,
  recordId: string
): Promise<{ triggerName: string; testClassName: string }> => {
  if (!SALESFORCE_RECORD_ID_PATTERN.test(recordId)) {
    throw new Error(`invalid_record_id:${recordId}`);
  }

  const { data } = await salesforceRequest<{ totalSize: number }>(
    { url: soqlUrl(instanceUrl, `SELECT Id FROM ${objectApiName} WHERE Id = '${recordId}' LIMIT 1`), method: 'GET' },
    tokens
  );
  if (data.totalSize === 0) {
    throw new Error(`record_not_found:${recordId}`);
  }

  const triggerName = triggerNameFor(objectApiName);
  const testClassName = testClassNameFor(triggerName);
  const testClassBody = buildTriggerRecoveryTestBody(objectApiName, testClassName, triggerName, recordId);

  await deployTriggerWithTestClass(instanceUrl, tokens, objectApiName, testClassBody, `Trigger ${triggerName} recovery`);

  return { triggerName, testClassName };
};

// ---------------------------------------------------------------------------
// Apex identifier naming — trigger/class names are capped at 40 characters.
// Objects with long API names (AccountContactRelation, CollaborationGroupRecord)
// push the test class past it, so the name is truncated and given a short
// digest of the trigger name to keep it unique — two truncated names must not
// collide.
// ---------------------------------------------------------------------------
const APEX_IDENTIFIER_MAX_LENGTH = 40;

const testClassNameFor = (triggerName: string): string => {
  const preferred = `${triggerName}Test`;
  if (preferred.length <= APEX_IDENTIFIER_MAX_LENGTH) { return preferred; }

  const digest = createHash('sha1').update(triggerName).digest('hex').slice(0, 6);
  const stem = triggerName.slice(0, APEX_IDENTIFIER_MAX_LENGTH - digest.length - '_Test'.length);
  return `${stem}${digest}_Test`;
};

// ---------------------------------------------------------------------------
// Sets a trigger's Status via a Metadata API deploy of just the trigger
// component — shared by activate and inactivate. Production orgs reject
// Tooling API writes on ApexTrigger, so this is the only supported way to
// flip an existing trigger's status; the ApexTrigger metadata type's <status>
// (unlike Flow's) does take effect on deploy. buildTriggerBody is a pure,
// deterministic function of objectApiName, so redeploying the unchanged body
// alongside the new status is safe and idempotent. A deploy containing Apex
// still requires a testLevel other than NoTestRun, so this re-runs the
// already-deployed test class (RunSpecifiedTests) rather than redeploying it.
// ---------------------------------------------------------------------------
const deployTriggerStatus = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  objectApiName: string,
  status: 'Active' | 'Inactive',
  testClassName: string
): Promise<void> => {
  const triggerName = triggerNameFor(objectApiName);

  const packageXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <types>\n` +
    `        <members>${triggerName}</members>\n` +
    `        <name>ApexTrigger</name>\n` +
    `    </types>\n` +
    `    <version>${API_VERSION}</version>\n` +
    `</Package>`;

  const triggerMetaXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <apiVersion>${API_VERSION}</apiVersion>\n` +
    `    <status>${status}</status>\n` +
    `</ApexTrigger>`;

  const zip = new JSZip();
  zip.file(`triggers/${triggerName}.trigger`, buildTriggerBody(objectApiName));
  zip.file(`triggers/${triggerName}.trigger-meta.xml`, triggerMetaXml);
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
      testLevel: 'RunSpecifiedTests',
      runTests: [testClassName],
    },
    `Trigger ${triggerName} ${status}`
  );
};

// ---------------------------------------------------------------------------
// Delete one trigger and its generated test class in a single destructive
// deploy. The test class only exists to cover the trigger, so leaving it
// behind would orphan an uncoverable class in the org — included only when
// actually present, since destructiveChanges on a missing member errors.
//
// testLevel RunLocalTests: production deploys touching Apex must run tests,
// and this uses the org's real overall Apex coverage rather than a synthetic
// always-passing class — if the org is below Salesforce's 75% bar, this fails
// and surfaces that honestly instead of masking it.
// ---------------------------------------------------------------------------
const deleteSingleTrigger = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  triggerName: string,
  testClassName: string
): Promise<void> => {
  const testClassId = await fetchApexClassId(instanceUrl, tokens, testClassName);

  await destructiveDeploy(
    instanceUrl,
    tokens,
    [
      { type: 'ApexTrigger', name: triggerName },
      ...(testClassId ? [{ type: 'ApexClass', name: testClassName }] : []),
    ],
    `Trigger ${triggerName} delete`,
    { testLevel: 'RunLocalTests' }
  );
};

// ---------------------------------------------------------------------------
// Grants permission set access after trigger creation/activation:
//   1. Apex Class access — every managed-package class the trigger's call
//      chain touches (SALESFORCE_PERMISSION_SET_APEX_CLASSES), not just the
//      handler itself: the Queueable it enqueues, the DTO/callout/exception
//      classes on that path all need SetupEntityAccess too, or the async
//      Queueable step fails with an Apex class access error despite the
//      trigger itself deploying fine.
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

    for (const className of SALESFORCE_PERMISSION_SET_APEX_CLASSES) {
      const classId = await fetchApexClassId(instanceUrl, tokens, className);
      if (classId) {
        await grantApexClassAccess(instanceUrl, tokens, permissionSetId, classId);
      }
    }

    await grantExternalCredentialPrincipalAccess(
      instanceUrl,
      tokens,
      PERMISSION_SET_NAME,
      'DataVault Real-Time Trigger Access',
      withNamespace(SALESFORCE_EXTERNAL_CREDENTIAL_PRINCIPAL)
    );

    for (const trigger of triggerResults) {
      if (trigger.status === 'CREATED') { trigger.permissionSetStatus = 'CREATED'; }
    }
  } catch (error) {
    // A failure here (e.g. the handler class access grant) means every step
    // after it in the try block was skipped too — logged loudly since it was
    // previously only a console.log, silently visible nowhere but the stored
    // triggerResult.permissionSetError.
    logger.error(`[permission-set] setup failed: ${error instanceof Error ? error.message : String(error)}`);
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
// and is what every generated trigger calls, so a missing package means dead triggers.
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
  const soql = `SELECT Id FROM PermissionSet WHERE Name = '${PERMISSION_SET_NAME}' WITH USER_MODE LIMIT 1`;
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

  // SetupEntityType is NOT sent — it's a read-only, system-derived field
  // (Salesforce infers it from SetupEntityId's key prefix). Sending it
  // explicitly fails the insert with INVALID_FIELD_FOR_INSERT_UPDATE.
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
// Expand the configured objects with their Master-Detail children so a
// trigger is created on each child too. Deduped (case-insensitive) — a child
// reachable from two parents gets a single trigger. Best-effort: a failed
// children lookup for one object leaves the rest of the list intact.
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
// Create an Apex Trigger + generated Test Class for one or more objects,
// sequentially. Handler class is ensured once before all trigger creations.
// A FAILED result carries needsRecoveryRecordId so the caller knows to prompt
// for a record Id and run the recovery path (recoverTriggerCreation) instead
// of just surfacing the error.
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
    const testClassName = testClassNameFor(triggerName);
    try {
      const existing = await fetchApexTriggerStatus(instanceUrl, tokens, triggerName);
      if (existing?.Status === 'Active') {
        results.push({ objectApiName, triggerName, testClassName, status: 'EXIST' });
        continue;
      }
      await createSingleTrigger(instanceUrl, tokens, objectApiName);
      results.push({ objectApiName, triggerName, testClassName, status: 'CREATED' });
      await timer(500);
    } catch (err) {
      console.log(`Error creating trigger for ${objectApiName}:`, err);
      results.push({
        objectApiName,
        triggerName,
        testClassName,
        status: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
        needsRecoveryRecordId: true,
      });
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
// Shared toggle — sets every object's trigger to the requested Salesforce
// status.
// ACTIVE  : creates the trigger if absent, patches Inactive → Active, then
//           runs permission set setup for any newly created triggers.
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

  if (!config.triggerResults?.length) {
    return [{ objectApiName: 'N/A', status: 'NOT_FOUND', error: 'No objects specified in backup config.' }];
  }

  const triggerResults = config.triggerResults;

  for (let i = 0; i < triggerResults.length; i++) {
    const triggerResult = triggerResults[i];
    const objectApiName = objectApiNameOf(config, triggerResult);
    const triggerName = triggerNameFor(objectApiName);
    const testClassName = testClassNameOf(triggerName, triggerResult);
    triggerResult.objectApiName = objectApiName;
    triggerResult.triggerName = triggerName;
    triggerResult.testClassName = testClassName;
    try {
      const trigger = await fetchApexTriggerStatus(instanceUrl, tokens, triggerName);

      if (targetStatus === 'Active') {
        if (!trigger) {
          await createSingleTrigger(instanceUrl, tokens, objectApiName);
          triggerResult.status = 'CREATED';
          await timer(500);
        } else if (trigger.Status === 'Active') {
          triggerResult.status = 'EXIST';
        } else {
          await deployTriggerStatus(instanceUrl, tokens, objectApiName, 'Active', testClassName);
          triggerResult.status = 'CREATED';
        }
      } else {
        if (!trigger) {
          triggerResult.status = 'NOT_FOUND';
        } else if (trigger.Status === 'Inactive') {
          triggerResult.status = 'INACTIVE';
        } else {
          await deployTriggerStatus(instanceUrl, tokens, objectApiName, 'Inactive', testClassName);
          triggerResult.status = 'INACTIVE';
        }
      }
    } catch (err) {
      const label = targetStatus === 'Active' ? 'activating' : 'inactivating';
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[trigger-${label}] ${objectApiName}: failed — ${message}`);
      triggerResult.status = targetStatus === 'Active' ? 'FAILED' : 'INACTIVATE_FAILED';
      triggerResult.error = message;
    }
  }

  if (targetStatus === 'Active') {
    await setupPermissionSet(instanceUrl, tokens, triggerResults);
  }

  return triggerResults;
};

// ---------------------------------------------------------------------------
// Delete every PermissionSetAssignment on a permission set before the set
// itself is destroyed. PermissionSetAssignment is a regular SObject (e.g. an
// admin assigning the set to the integration user via Setup), not a metadata
// component, so this goes through the standard Data API's sObject Collections
// DELETE rather than a Metadata API deploy — up to 200 Ids per call, chunked.
// ---------------------------------------------------------------------------
const COMPOSITE_DELETE_CHUNK_SIZE = 200;

const deletePermissionSetAssignments = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  permissionSetId: string
): Promise<void> => {
  const { data } = await salesforceRequest<{ records: { Id: string }[] }>(
    {
      url: soqlUrl(instanceUrl, `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '${permissionSetId}'`),
      method: 'GET',
    },
    tokens
  );
  const ids = (data.records ?? []).map((record) => record.Id);
  if (!ids.length) { return; }

  for (let i = 0; i < ids.length; i += COMPOSITE_DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + COMPOSITE_DELETE_CHUNK_SIZE);
    await salesforceRequest(
      {
        url: `${instanceUrl}/services/data/v${API_VERSION}/composite/sobjects?ids=${chunk.join(',')}&allOrNone=false`,
        method: 'DELETE',
      },
      tokens
    );
  }
};

// ---------------------------------------------------------------------------
// Delete the DataVaultRealTimeTriggerAccess permission set via Metadata API
// deploy — assignments first (see deletePermissionSetAssignments), since the
// set can't be meaningfully in use once its own triggers are gone. Called
// after all triggers are deleted so the permission set is cleaned up too.
// No-op if the permission set doesn't exist.
// ---------------------------------------------------------------------------
const deletePermissionSet = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<void> => {
  const existing = await fetchPermissionSetId(instanceUrl, tokens);
  if (!existing) { return; }

  await deletePermissionSetAssignments(instanceUrl, tokens, existing);

  await destructiveDeploy(
    instanceUrl,
    tokens,
    [{ type: 'PermissionSet', name: PERMISSION_SET_NAME }],
    'Permission set delete'
  );
};

// Other real-time backup configs on the same CRM connection (org), excluding
// the one passed in. Triggers, test classes and the permission set are all
// shared org-wide resources across every real-time config on that connection
// — deleteTriggers and checkSharedTriggerConflict below both need to know
// about siblings before touching anything.
const getSiblingRealtimeConfigs = async (config: IBackupConfig): Promise<IBackupConfig[]> =>
  (await getBackupConfigsByCrm(config.crmId)).filter(
    (sibling) => sibling.backupConfigId !== config.backupConfigId && sibling.schedule === SCHEDULE_MODE.realtime
  );

// ---------------------------------------------------------------------------
// Guards the pause/inactivate path: an object's trigger is one shared
// component per org, not one per config, so inactivating it here would also
// silently stop real-time sync for any other config still using that object.
// Unlike delete (which skips the shared object and keeps going), this blocks
// the whole operation up front and explains exactly which object(s) and which
// other config(s) are the conflict — returns null when it's safe to proceed.
// ---------------------------------------------------------------------------
const checkSharedTriggerConflict = async (config: IBackupConfig): Promise<string | null> => {
  const siblings = await getSiblingRealtimeConfigs(config);
  if (!siblings.length) { return null; }

  const conflicts = (config.objectNames ?? [])
    .map((objectApiName) => ({
      objectApiName,
      sharedWith: siblings
        .filter((sibling) => (sibling.objectNames ?? []).some((name) => name.toLowerCase() === objectApiName.toLowerCase()))
        .map((sibling) => sibling.name || sibling.backupConfigId),
    }))
    .filter((c) => c.sharedWith.length > 0);

  if (!conflicts.length) { return null; }

  const detail = conflicts.map((c) => `${c.objectApiName} (also used by: ${c.sharedWith.join(', ')})`).join('; ');
  return (
    `Cannot inactivate this real-time backup config: the following object(s) are shared with another ` +
    `real-time backup config in the same org, and inactivating the trigger here would also stop real-time ` +
    `sync for that config — ${detail}. Remove the shared object(s) from one config, or pause both, before pausing this one.`
  );
};

// ---------------------------------------------------------------------------
// Delete triggers — permanently removes each object's Apex Trigger + Test
// Class from the org, then the permission set. Both are shared, org-wide
// resources when more than one real-time backup config exists for the same
// CRM connection, so neither is safe to delete unconditionally:
//   - An object's trigger/test class is skipped (SKIPPED_SHARED) if another
//     real-time config in this org still lists that object.
//   - The permission set is only deleted if this is the last real-time config
//     left in the org — otherwise a sibling config's handler-class/external-
//     credential access would be deleted out from under it.
// No-op for objects whose trigger doesn't exist.
// ---------------------------------------------------------------------------
const deleteTriggers = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  config: IBackupConfig
): Promise<ITriggerResult[]> => {
  // triggerResults is bookkeeping, not the source of truth — it can be empty or
  // stale (e.g. the post-response write that persists it after creation never
  // landed) while the org still has a live trigger. Fall back to objectNames,
  // so cleanup isn't skipped just because the tracking record is missing.
  const triggerResults: ITriggerResult[] = config.triggerResults?.length
    ? config.triggerResults
    : (config.objectNames ?? []).map((objectApiName) => ({
        objectApiName,
        status: 'CREATED' as const,
      }));

  if (!triggerResults.length) {
    return [{ objectApiName: 'N/A', status: 'NOT_FOUND', error: 'No objects specified in backup config.' }];
  }

  const siblingRealtimeConfigs = await getSiblingRealtimeConfigs(config);
  const sharedObjectNames = new Set(
    siblingRealtimeConfigs.flatMap((sibling) => sibling.objectNames ?? []).map((name) => name.toLowerCase())
  );
  const isLastRealtimeConfig = siblingRealtimeConfigs.length === 0;

  for (const triggerResult of triggerResults) {
    const objectApiName = objectApiNameOf(config, triggerResult);
    const triggerName = triggerNameFor(objectApiName);
    const testClassName = testClassNameOf(triggerName, triggerResult);
    triggerResult.objectApiName = objectApiName;
    triggerResult.triggerName = triggerName;
    triggerResult.testClassName = testClassName;

    if (sharedObjectNames.has(objectApiName.toLowerCase())) {
      triggerResult.status = 'SKIPPED_SHARED';
      logger.info(`[trigger-delete] ${objectApiName}: still used by another real-time config in this org — trigger kept`);
      continue;
    }

    // No status gate: attempting delete regardless of the last recorded status
    // is what catches the case that status has drifted from what's actually
    // deployed.
    try {
      const trigger = await fetchApexTriggerStatus(instanceUrl, tokens, triggerName);
      if (!trigger) {
        triggerResult.status = 'NOT_FOUND';
        logger.info(`[trigger-delete] ${objectApiName}: no trigger found in org`);
        continue;
      }

      await deleteSingleTrigger(instanceUrl, tokens, triggerName, testClassName);

      triggerResult.status = 'DELETED';
      logger.info(`[trigger-delete] ${objectApiName}: deleted trigger ${triggerName}`);
    } catch (err) {
      triggerResult.status = 'DELETE_FAILED';
      triggerResult.error = err instanceof Error ? err.message : String(err);
      logger.error(`[trigger-delete] ${objectApiName}: failed — ${triggerResult.error}`);
    }
  }

  // The permission set is shared org-wide infrastructure, not per-config —
  // only tear it down once no other real-time config in this org needs it.
  if (isLastRealtimeConfig) {
    try {
      await deletePermissionSet(instanceUrl, tokens);
      logger.info(`[trigger-delete] permission set '${PERMISSION_SET_NAME}' deleted`);
    } catch (err) {
      logger.error(`[trigger-delete] failed to delete permission set: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    logger.info(`[trigger-delete] permission set kept — ${siblingRealtimeConfigs.length} other real-time config(s) remain in this org`);
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
      // // Children get a trigger, so they get backed up — record them on the config
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
  recoverTriggerCreation,
  checkSharedTriggerConflict,
};
