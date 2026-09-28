import { IRequest, IResponse, makeResponse } from '../lib';
import { logger } from '../middlewares';
import { IBackupObject } from '../models';
import { SYSTEM_FIELDS } from '../constant';

type IHandler = (req: IRequest, res: IResponse) => Promise<void>;

// Throw this from service/controller code to set a specific HTTP status.
// Anything that isn't an HttpError is treated as an unexpected server error (500).
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const randomNumber = (digits: number = 6): string => {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
};

// Parse a JWT expiry string like "7d", "15m", "3600s" into seconds
const parseExpiryToSeconds = (expiry: string): number => {
  const unit = expiry.slice(-1);
  const value = parseInt(expiry.slice(0, -1), 10);
  const map: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (map[unit] ?? 1);
};

const asyncHandler =
  (fn: IHandler): IHandler =>
  async (req: IRequest, res: IResponse): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error: unknown) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : 'unknown_error';
      logger.error(`[${statusCode}] ${req.method} ${req.originalUrl} : ${message}`);
      makeResponse(
        req,
        res,
        statusCode,
        false,
        (message || 'unknown_error') as Parameters<typeof makeResponse>[4]
      );
    }
  };

const wrapController = <T extends Record<string, IHandler>>(controller: T): T =>
  Object.fromEntries(Object.entries(controller).map(([key, fn]) => [key, asyncHandler(fn)])) as T;

type S3KeyOperation = 'inserts' | 'updates' | 'deletes';
type S3KeyType = 'backup' | 'archival';

interface IS3KeyPrefixParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  backupJobId: string;
  objectName: string;
  type: S3KeyType;
  operation?: S3KeyOperation;
}

// Builds the S3 key prefix for raw data uploads.
// Backup paths include an operation sub-folder (inserts / updates / deletes).
// Archival paths omit it — files are differentiated by a UUID suffix appended at upload time.
//
// backupJobId MUST stay in this path (raw_data/<backupJobId>/<objectName>/...), not just
// backupConfigId. Older builds keyed by raw_data/<objectName>/... only — one shared,
// config-wide folder per object — so every job for that object (initial backup, every
// retrigger, every realtime hit) wrote/overwrote into the same place instead of its own
// scoped folder. Fixed by commit 2333cb7 ("Real-Time Transaction and S3 Prefix Issue Fix").
// If you see raw_data/<objectName>/ with no id folder in between in S3, that data was
// written by a build that predates this fix, not by anything on this branch.
const buildS3KeyPrefix = ({
  crmId,
  crmName,
  backupConfigId,
  backupJobId,
  objectName,
  type,
  operation,
}: IS3KeyPrefixParams): string => {
  const base = `${crmName}/${crmId}/${type}/${backupConfigId}/raw_data/${backupJobId}/${objectName}`;
  return operation ? `${base}/${operation}` : base;
};

interface ISchemaS3KeyParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
}

// Pre-versioning field schema location. Nothing writes here any more — it is the
// read fallback for configs whose last job predates the main/changes layout.
const buildSchemaS3Key = ({
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
}: ISchemaS3KeyParams): string =>
  `${crmName}/${crmId}/${type}/${backupConfigId}/schema/${objectName}/fields/fields.json`;

// ---------------------------------------------------------------------------
// Versioned schema layout (scheduled backup + archival jobs)
//
//   schema/main/<object>/<kind>/...                    — the latest version, READ-ONLY
//                                                        for this service (owned by
//                                                        Schema-Sync, which promotes
//                                                        a changes/ copy into it)
//   schema/changes/<backupJobId>/<object>/<kind>/...   — what that job wrote; the only
//                                                        thing this service writes
//
// Picklists carry an extra {fieldApiName} level, one file per picklist field.
// The Java Spark middleware must read schema/main/{object}/fields/fields.json — it
// previously read the legacy folder (docs/architecture-graph/java/JAVA_SCHEMA_EVOLUTION.md).
// ---------------------------------------------------------------------------
type SchemaKind = 'fields' | 'childs' | 'picklist' | 'recordTypes';

export const SCHEMA_KIND_FILE: Record<SchemaKind, string> = {
  fields: 'fields.json',
  childs: 'childs.json',
  picklist: 'values.json',
  recordTypes: 'record-types.json',
};

interface ISchemaKeyParams extends ISchemaS3KeyParams {
  kind: SchemaKind;
  fieldApiName?: string; // picklist only
  backupJobId?: string; // set → changes/<backupJobId>; omitted → main
}

const buildSchemaKey = ({
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
  kind,
  fieldApiName,
  backupJobId,
}: ISchemaKeyParams): string => {
  const scope = backupJobId ? `changes/${backupJobId}` : 'main';
  const tail = kind === 'picklist' ? `picklist/${fieldApiName}` : kind;
  return `${crmName}/${crmId}/${type}/${backupConfigId}/schema/${scope}/${objectName}/${tail}/${SCHEMA_KIND_FILE[kind]}`;
};

// The legacy layout kept every version as fields_<ts>.json beside the original
// fields.json. Timestamps are fixed-width, so the last alphabetically sorted
// versioned key is also the newest; fall back to the base key when none exist.
const pickLegacyFieldsKey = (keys: string[], baseKey: string): string => {
  const versioned = keys.filter((k) => /fields_\d+\.json$/.test(k));
  return versioned.length ? versioned[versioned.length - 1] : baseKey;
};

interface IErrorLogsS3PrefixParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  backupJobId: string;
  objectName: string;
  objectId: string;
  type?: S3KeyType;
}

// Sibling of raw_data — record-level delete errors live under error_logs at the
// same level as raw_data so the bucket layout for a config stays consistent.
// Scoped per backupJobId so errors from concurrent or retried runs never collide.
const buildErrorLogsS3Prefix = ({
  crmId,
  crmName,
  backupConfigId,
  backupJobId,
  objectName,
  objectId,
  type = 'archival',
}: IErrorLogsS3PrefixParams): string =>
  `${crmName}/${crmId}/${type}/${backupConfigId}/error_logs/${backupJobId}/${objectName}/${objectId}`;

// ---------------------------------------------------------------------------
// object-children returns every relationship (relationshipType=ALL). A child is
// backed up alongside its parent only when the parent's records own it
// (Master-Detail) or the relationship is required — those records are unreachable
// or meaningless without the parent, so each one gets its own bulk query job.
// Optional lookups are still stored in the schema file; the user adds them to the
// config themselves if they want them backed up.
// ---------------------------------------------------------------------------
// NOTE: the request vocabulary and the response vocabulary differ. `relationshipType`
// as a *filter* is master|lookup|required_lookup, but the child DTO *reports*
// 'MasterDetail'|'Lookup' — so both spellings are accepted here.
const isBackupChild = (child: { relationshipType?: string; isRequired?: boolean }): boolean => {
  const type = String(child?.relationshipType ?? '').toUpperCase();
  return type === 'MASTER' || type === 'MASTERDETAIL' || child?.isRequired === true;
};

// ---------------------------------------------------------------------------
// Order-independent schema equality check.
// Compares two field arrays by stable field identifier (apiName or name) and
// dataType only — immune to key-insertion-order differences that trip up
// JSON.stringify-based comparisons.
// ---------------------------------------------------------------------------
const schemasAreEqual = (existing: any[], latest: any[]): boolean => {
  if (existing.length !== latest.length) {
    return false;
  }
  const key = (f: any): string => f.apiName ?? f.name ?? '';
  const sorted = (arr: any[]) => [...arr].sort((a, b) => key(a).localeCompare(key(b)));
  return sorted(existing).every((ef, i) => {
    const lf = sorted(latest)[i];
    return key(ef) === key(lf) && ef.dataType === lf.dataType;
  });
};

// Split a full CSV string into rows, correctly handling quoted fields that
// contain embedded newlines. Returns non-empty rows only.
const splitCSVRows = (csv: string): string[] => {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if ((char === '\n' || (char === '\r' && next === '\n')) && !inQuotes) {
      if (char === '\r') {
        i++;
      } // skip the \n of \r\n
      if (current.trim()) {
        rows.push(current);
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    rows.push(current);
  }
  return rows;
};

// Parse CSV line respecting quoted fields (handles commas inside quotes)
const parseCSVLine = (line: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
};

const formatFieldValuesForSOQL = (fields: any[]): any[] => {
  return fields.map((field) => {
    if (!field.filter) {
      return field;
    }

    const formattedValue = formatValueByDataType(field.filter.value, field.dataType);

    return {
      ...field,
      filter: {
        ...field.filter,
        value: formattedValue,
      },
    };
  });
};

// Strips currency symbols, thousands-separator commas, and surrounding
// whitespace before a numeric-type value is embedded as a bare (unquoted)
// SOQL literal. A Currency field's UI input is the one numeric type likely to
// arrive formatted (e.g. "$1,234.56") — unlike Integer/Decimal/Percent, which
// typically don't get symbol/grouping treatment — and an unstripped comma or
// symbol there produces invalid SOQL ("Field = $1,234.56" / "Field = 1,234.56",
// a bare comma outside any list context), which Salesforce rejects outright.
const sanitizeNumericValue = (value: string): string => value.trim().replace(/[^0-9.-]/g, '');

const formatValueByDataType = (value: string, dataType: string): string => {
  if (!value && value !== '0' && value !== 'false') {
    return value;
  }

  // Field-Level filter values reach here typed as `string` only at compile
  // time — a numeric input (Currency, Percent, ...) can arrive as a real JS
  // number, and sanitizeNumericValue's .trim()/.replace() throw on anything
  // that isn't already a string.
  const strValue = String(value);
  // trim(): a dataType string with stray whitespace (copy-paste, upstream
  // metadata quirk) would silently fall through to the default: quoted-string
  // branch below instead of matching a numeric case — trim it out here rather
  // than let every case label carry its own defensive check.
  const lowerDataType = dataType.trim().toLowerCase();

  switch (lowerDataType) {
    case 'string':
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'url':
    case 'picklist':
    case 'multipicklist':
      return `'${escapeSOQLString(strValue)}'`;

    // SOQL date/datetime/time literals are unquoted (WHERE CreatedDate = 2026-09-02,
    // not '2026-09-02') — quoting them makes Salesforce treat the literal as a
    // string against a Date/DateTime/Time field, which it rejects with "must be
    // of type date/datetime/time and should not be enclosed in quotes".
    case 'date':
      return formatDate(strValue);

    case 'datetime':
      return formatDateTime(strValue);

    case 'time':
      return formatTime(strValue);

    case 'integer':
    case 'double':
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'number':
      return sanitizeNumericValue(strValue);

    case 'boolean':
      return isTruthy(strValue) ? 'true' : 'false';

    default:
      return `'${escapeSOQLString(strValue)}'`;
  }
};

const isTruthy = (value: string | boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = String(value).toLowerCase().trim();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return Boolean(value);
};

const escapeSOQLString = (str: string): string => {
  return str.replace(/'/g, "''");
};

// Escapes a value for safe interpolation into template-literal HTML — used
// by the email templates (services/common/email) for any dynamic
// string they render (object/config names, error messages) that can
// originate from user input, guarding against HTML/script injection.
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
};

const formatDateTime = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toISOString();
};

// SOQL Time literal format is HH:MM:SS.sssZ — the trailing Z is a fixed part
// of the literal syntax, not a UTC offset: Salesforce's Time type carries no
// timezone at all, so unlike formatDateTime there's no timezone conversion to
// do, only normalization. A UI time input can arrive as "H:MM", "HH:MM",
// "HH:MM:SS", "HH:MM:SS.sss", or already the full literal — all of those
// match and get padded out to the same shape. Anything else (e.g. a picker
// that submits a full date/datetime string) falls back to parsing it as a
// Date and reading off its time-of-day component. Mirrors client-service's
// own copy of this function (utils/helper.ts, formatSalesforceValueByDataType's
// case 'time') byte-for-byte — that one drives the dry-run preview SOQL, this
// one drives the archival job's actual SOQL, and the two must always agree on
// what a filter value compiles to.
const TIME_VALUE_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?$/;

const formatTime = (timeString: string): string => {
  const match = TIME_VALUE_RE.exec(timeString.trim());
  if (match) {
    const [, hh, mm, ss = '00', ms = '000'] = match;
    return `${hh.padStart(2, '0')}:${mm}:${ss}.${ms.padEnd(3, '0')}Z`;
  }

  const date = new Date(timeString);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().split('T')[1];
  }

  // Unparseable — pass through rather than emit a worse-mangled value; the
  // subsequent Salesforce query will reject it with a clearer error than
  // anything we could construct here.
  return timeString;
};

const recursivelyFlatten = (objects: IBackupObject[]): IBackupObject[] => {
  return objects.flatMap((obj) => [obj, ...(obj.children ? recursivelyFlatten(obj.children) : [])]);
};

const withSystemFields = (fieldNames: string[]): string[] =>
  Array.from(new Set([...fieldNames, ...SYSTEM_FIELDS]));

// interface InputNode {
//   name: string;
//   parents?: InputNode[];
// }

// interface HierarchyNode {
//   name: string;
//   children: HierarchyNode[];
// }

// interface InternalNode {
//   name: string;
//   children: Map<string, InternalNode>;
// }

// function buildParentToChildHierarchy(data: InputNode[]): HierarchyNode[] {
//   const nodes = new Map<string, InternalNode>();

//   function getNode(name: string): InternalNode {
//     let node = nodes.get(name);

//     if (!node) {
//       node = {
//         name,
//         children: new Map<string, InternalNode>(),
//       };

//       nodes.set(name, node);
//     }

//     return node;
//   }

//   function process(item: InputNode): void {
//     const child = getNode(item.name);

//     for (const parent of item.parents ?? []) {
//       const parentNode = getNode(parent.name);

//       // parent -> child
//       parentNode.children.set(child.name, child);

//       // Process parent's parents
//       process(parent);
//     }
//   }

//   // Build the complete relationship tree
//   for (const item of data) {
//     process(item);
//   }

//   // Find root nodes
//   const hasParent = new Set<string>();

//   for (const node of nodes.values()) {
//     for (const child of node.children.values()) {
//       hasParent.add(child.name);
//     }
//   }

//   // Convert internal Map structure to final array structure
//   function convert(node: InternalNode): HierarchyNode {
//     return {
//       name: node.name,
//       children: Array.from(node.children.values()).map(convert),
//     };
//   }

//   return Array.from(nodes.values())
//     .filter((node) => !hasParent.has(node.name))
//     .map(convert);
// }

interface InputNode {
  name: string;
  parents?: InputNode[];
}

interface HierarchyNode {
  name: string;
  children: HierarchyNode[];
}

function buildParentToChildHierarchy(data: InputNode[]): HierarchyNode[] {
  // name -> possible parents
  const parentMap = new Map<string, Set<string>>();

  function collect(node: InputNode) {
    if (!parentMap.has(node.name)) {
      parentMap.set(node.name, new Set());
    }

    for (const parent of node.parents ?? []) {
      parentMap.get(node.name)!.add(parent.name);
      collect(parent);
    }
  }

  // Collect all relationships
  for (const item of data) {
    collect(item);
  }

  // Calculate how deep a node can be from the root
  const depthCache = new Map<string, number>();

  function getDepth(name: string, visiting = new Set<string>()): number {
    if (depthCache.has(name)) {
      return depthCache.get(name)!;
    }

    // Protect against circular relationships
    if (visiting.has(name)) {
      return 0;
    }

    visiting.add(name);

    const parents = parentMap.get(name);

    if (!parents || parents.size === 0) {
      depthCache.set(name, 0);
      return 0;
    }

    let maxDepth = 0;

    for (const parent of parents) {
      maxDepth = Math.max(maxDepth, getDepth(parent, new Set(visiting)) + 1);
    }

    depthCache.set(name, maxDepth);

    return maxDepth;
  }

  // --------------------------------------------------
  // Select the deepest parent for every node
  // --------------------------------------------------

  const selectedParent = new Map<string, string>();

  for (const [child, parents] of parentMap) {
    let bestParent: string | undefined;
    let bestDepth = -1;

    for (const parent of parents) {
      const depth = getDepth(parent);

      if (depth > bestDepth) {
        bestDepth = depth;
        bestParent = parent;
      }
    }

    if (bestParent) {
      selectedParent.set(child, bestParent);
    }
  }

  // --------------------------------------------------
  // Build final hierarchy
  // --------------------------------------------------

  const nodes = new Map<string, HierarchyNode>();

  function getNode(name: string): HierarchyNode {
    if (!nodes.has(name)) {
      nodes.set(name, {
        name,
        children: [],
      });
    }

    return nodes.get(name)!;
  }

  // Ensure every collected node (including those without a parent) is
  // represented, so a parentless node that no one else references is
  // still returned as a root instead of being dropped.
  for (const name of parentMap.keys()) {
    getNode(name);
  }

  for (const [child, parent] of selectedParent) {
    const parentNode = getNode(parent);
    const childNode = getNode(child);

    if (!parentNode.children.some((x) => x.name === child)) {
      parentNode.children.push(childNode);
    }
  }

  // Find roots
  const children = new Set(selectedParent.keys());

  return [...nodes.values()].filter((node) => !children.has(node.name));
}

// Flattens a parent→child hierarchy (buildParentToChildHierarchy's output) into a
// single ordered list where every node appears only after all of its own
// descendants — the reverse of the tree's natural parent-first order. A child's
// records can reference its parent's, so a rollback that undoes a restore must
// process objects in this order instead of parent-first.
function reverseHierarchy(nodes: HierarchyNode[]): HierarchyNode[] {
  const ordered: HierarchyNode[] = [];

  function visit(node: HierarchyNode) {
    for (const child of node.children ?? []) {
      visit(child);
    }
    ordered.push(node);
  }

  for (const node of nodes) {
    visit(node);
  }

  return ordered;
}

export {
  randomNumber,
  parseExpiryToSeconds,
  wrapController,
  buildS3KeyPrefix,
  buildSchemaS3Key,
  buildSchemaKey,
  pickLegacyFieldsKey,
  buildErrorLogsS3Prefix,
  isBackupChild,
  schemasAreEqual,
  splitCSVRows,
  parseCSVLine,
  formatFieldValuesForSOQL,
  formatValueByDataType,
  recursivelyFlatten,
  withSystemFields,
  escapeHtml,
  buildParentToChildHierarchy,
  reverseHierarchy,
  type IS3KeyPrefixParams,
  type ISchemaS3KeyParams,
  type ISchemaKeyParams,
  type SchemaKind,
  type S3KeyType,
};
