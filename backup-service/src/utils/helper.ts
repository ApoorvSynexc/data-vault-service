import { IRequest, IResponse, makeResponse } from '../lib';
import { logger } from '../middlewares';
import { IBackupObject, IRestoreObjectHierarchyNode } from '../models';
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

const formatValueByDataType = (value: string, dataType: string): string => {
  if (!value && value !== '0' && value !== 'false') {
    return value;
  }

  const lowerDataType = dataType.toLowerCase();

  switch (lowerDataType) {
    case 'string':
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'url':
    case 'picklist':
    case 'multipicklist':
      return `'${escapeSOQLString(value)}'`;

    case 'date':
      return `'${formatDate(value)}'`;

    case 'datetime':
      return `'${formatDateTime(value)}'`;

    case 'integer':
    case 'double':
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'number':
      return value;

    case 'boolean':
      return isTruthy(value) ? 'true' : 'false';

    default:
      return `'${escapeSOQLString(value)}'`;
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
// by the email templates (services/common/email-templates) for any dynamic
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

const recursivelyFlatten = (objects: IBackupObject[]): IBackupObject[] => {
  return objects.flatMap((obj) => [obj, ...(obj.children ? recursivelyFlatten(obj.children) : [])]);
};

interface IHierarchyEdges {
  allNames: Set<string>;
  childNamesByParent: Map<string, Set<string>>;
  directParentNamesByChild: Map<string, Set<string>>;
}

// Walks a restore's child->parent hierarchy (IRestoreObjectHierarchyNode —
// each node names its own upward parent chain) once and collects every
// parent->child edge, deduped by name. The same object can be reachable
// through more than one branch — e.g. Contact under both Account and
// Opportunity->Product — so this resolves to shared edges per name rather
// than one copy of the object per branch that reaches it.
// A `path`-scoped (not global) visited guard is used so a genuinely shared
// ancestor is still walked once per distinct path to it (needed to collect
// every one of its parent edges), while an actual cycle still terminates.
const collectHierarchyEdges = (nodes: IRestoreObjectHierarchyNode[]): IHierarchyEdges => {
  const allNames = new Set<string>();
  const childNamesByParent = new Map<string, Set<string>>();
  const directParentNamesByChild = new Map<string, Set<string>>();

  const visit = (node: IRestoreObjectHierarchyNode, path: Set<string>): void => {
    allNames.add(node.name);
    if (path.has(node.name)) {
      return;
    }
    const nextPath = new Set(path).add(node.name);
    (node.parents ?? []).forEach((parent) => {
      allNames.add(parent.name);
      if (!childNamesByParent.has(parent.name)) {
        childNamesByParent.set(parent.name, new Set());
      }
      childNamesByParent.get(parent.name)!.add(node.name);
      if (!directParentNamesByChild.has(node.name)) {
        directParentNamesByChild.set(node.name, new Set());
      }
      directParentNamesByChild.get(node.name)!.add(parent.name);
      visit(parent, nextPath);
    });
  };
  nodes.forEach((node) => visit(node, new Set()));

  return { allNames, childNamesByParent, directParentNamesByChild };
};

export interface IRestoreExecutionPlan {
  // Every parent name precedes every one of its children. A name reachable
  // through more than one parent (a diamond) is placed only after ALL of its
  // parents, not just the first branch that reaches it.
  order: string[];
  // Each name's immediate parents, for callers that need to decide whether to
  // skip a node because one of ITS OWN parents (not a more distant ancestor)
  // failed to restore.
  directParentNamesByChild: Map<string, Set<string>>;
}

// Flattens a restore's child->parent hierarchy (IRestoreObjectHierarchyNode —
// each node names its own upward parent chain) into a single valid execution
// order (Kahn's algorithm): every parent before every one of its children,
// exactly once each. A name reachable through more than one parent (a
// diamond — e.g. Contact under both Account and Opportunity->Product) is
// placed only after ALL of its parents, not just the first one reached —
// walking the hierarchy as a per-branch tree instead would run that shared
// node twice, and could run it after only one of its parents.
const getRestoreExecutionPlan = (nodes: IRestoreObjectHierarchyNode[]): IRestoreExecutionPlan => {
  const { allNames, childNamesByParent, directParentNamesByChild } = collectHierarchyEdges(nodes);

  const remainingParentCount = new Map<string, number>();
  directParentNamesByChild.forEach((parents, name) => remainingParentCount.set(name, parents.size));

  const queue: string[] = Array.from(allNames).filter((name) => !remainingParentCount.has(name));
  const order: string[] = [];

  while (queue.length) {
    const name = queue.shift()!;
    order.push(name);
    (childNamesByParent.get(name) ?? new Set()).forEach((childName) => {
      const remaining = (remainingParentCount.get(childName) ?? 1) - 1;
      remainingParentCount.set(childName, remaining);
      if (remaining === 0) {
        queue.push(childName);
      }
    });
  }

  // A cycle (shouldn't happen for a valid lookup/master-detail graph) leaves
  // names permanently stuck above 0 remaining parents — append them at the
  // end rather than silently dropping the object from the restore.
  allNames.forEach((name) => {
    if (!order.includes(name)) {
      order.push(name);
    }
  });

  return { order, directParentNamesByChild };
};

// Ensures Salesforce's system fields are present in a field list — they're
// always selected by default for backup/archival. Call once, right after
// fetching/filtering the schema — every SOQL built from the result already
// carries them, no need to re-add per query.
const withSystemFields = (fieldNames: string[]): string[] =>
  Array.from(new Set([...fieldNames, ...SYSTEM_FIELDS]));

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
  getRestoreExecutionPlan,
  withSystemFields,
  escapeHtml,
  type IS3KeyPrefixParams,
  type ISchemaS3KeyParams,
  type ISchemaKeyParams,
  type SchemaKind,
  type S3KeyType,
};
