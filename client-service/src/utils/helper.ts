import jwt from 'jsonwebtoken';
import {
  JWT_ACCESS_EXPIRY,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_EXPIRY,
  JWT_REFRESH_SECRET,
  SCHEDULE_TYPE,
} from '../constant';
import { IRequest, IResponse, makeResponse } from '../lib';
import { SalesforceAuthExpiredError } from '../services/third-party/salesforce';
import { IBackupObject, IObject } from '../models';
import { logger } from '../middlewares';

type IHandler = (req: IRequest, res: IResponse) => Promise<void>;
type S3KeyType = 'backup' | 'archival';
interface ISchemaS3KeyParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
}

const randomNumber = (digits: number = 6): string => {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
};

const generateTokens = (userId: string, sessionId: string) => {
  const payload = { userId, sessionId };
  const accessToken = jwt.sign(payload, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRY as jwt.SignOptions['expiresIn'],
  });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRY as jwt.SignOptions['expiresIn'],
  });
  return { accessToken, refreshToken };
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
        if (error instanceof SalesforceAuthExpiredError) {
          makeResponse(req, res, 401, false, 'salesforce_reauth_required');
          return;
        }
        const message = error instanceof Error ? error.message : 'unknown_error';
        logger.error(`[400] ${req.method} ${req.originalUrl} : ${message}`);
        makeResponse(
          req,
          res,
          400,
          false,
          (message || 'unknown_error') as Parameters<typeof makeResponse>[4]
        );
      }
    };

const wrapController = <T extends Record<string, IHandler>>(controller: T): T =>
  Object.fromEntries(Object.entries(controller).map(([key, fn]) => [key, asyncHandler(fn)])) as T;

const toSlug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// count comes from an atomic DB counter — 1 = first occurrence (no suffix), 2+ = append suffix
const buildSlug = (base: string, count: number): string => {
  const baseSlug = toSlug(base) || 'item';
  return count === 1 ? baseSlug : `${baseSlug}-${count}`;
};

// Returns false when entity is null/undefined or belongs to neither this user
// nor (when passed) this CRM. crmId is optional so existing callers that only
// check userId keep working unchanged.
// Use this in controllers instead of repeating the ownership check inline.
const isOwner = (
  entity: { userId: string; crmId?: string } | null | undefined,
  userId: string,
  crmId?: string
): boolean =>
  !!entity && (entity.userId === userId || (crmId !== undefined && entity.crmId === crmId));

const timer = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// Flatten all nested objects (children at any depth) into a single array
const flattenBackupObjects = (objects: IBackupObject[]): IBackupObject[] => {
  if (!objects.length) return [];
  return objects.flatMap((obj) => [obj, ...(obj.children ? flattenBackupObjects(obj.children) : [])]);
};

const formatFieldValuesForSOQL = (fields: any[]): any[] => {
  return fields.map(field => {
    if (!field.filter) {
      return field;
    }

    const formattedValue = formatSalesforceValueByDataType(field.filter.value, field.dataType);

    return {
      ...field,
      filter: {
        ...field.filter,
        value: formattedValue
      }
    };
  });
};

const formatSalesforceValueByDataType = (value: string, dataType: string): string => {
  if (!value && value !== '0' && value !== 'false') return value;

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
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = String(value).toLowerCase().trim();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return Boolean(value);
};


const escapeSOQLString = (str: string): string => {
  return str.replace(/'/g, "''");
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
};

const formatDateTime = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toISOString();
};

const filtereObjects = (objects: IObject[]) => {
  const immediateObjects: IObject[] = [];
  const scheduledObjects: IObject[] = [];

  objects.forEach((obj: IObject) => {
    const isOnceImmediate = obj.scheduleConfig?.type === SCHEDULE_TYPE.oneTime
      && obj.scheduleConfig.scheduling?.frequency === 'ONCE'
      && !obj.scheduleConfig.scheduling?.startDate
      && !obj.scheduleConfig.scheduling?.startTime;
    if (isOnceImmediate) {
      immediateObjects.push(obj);
    } else {
      scheduledObjects.push(obj);
    }
  });

  return {
    immediateObjects,
    scheduledObjects
  }
}

// Pre-versioning schema locations. Nothing writes here any more — these three are
// read-only fallbacks for configs whose last backup job predates the main/changes layout.
const buildSchemaS3Key = ({
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
}: ISchemaS3KeyParams): string => `${crmName}/${crmId}/${type}/${backupConfigId}/schema/${objectName}/fields/fields.json`;

// Picklist values live beside the field schema:
// .../schema/{objectName}/picklist/{fieldApiName}/values.json
const buildPicklistS3Key = (params: ISchemaS3KeyParams & { fieldApiName: string }): string =>
  buildSchemaS3Key(params).replace(
    '/fields/fields.json',
    `/picklist/${params.fieldApiName}/values.json`
  );

// Record-type metadata, single unversioned file: .../schema/{objectName}/record-types.json
const buildRecordTypeS3Key = (params: ISchemaS3KeyParams): string =>
  buildSchemaS3Key(params).replace('/fields/fields.json', '/record-types.json');

// ---------------------------------------------------------------------------
// Versioned schema layout — mirrors backup-service/src/utils/helper.ts.
//
//   schema/main/<object>/<kind>/...                    — always the latest version
//   schema/changes/<backupJobId>/<object>/<kind>/...   — what that job wrote
//
// Readers use main/ and fall back to the legacy builders above for configs whose
// last backup predates this layout.
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

// Order-independent schema equality by field identifier + dataType only — mirrors
// backup-service so the /payload drift check matches the backup's own comparison.
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

export {
  filtereObjects,
  randomNumber,
  generateTokens,
  parseExpiryToSeconds,
  wrapController,
  toSlug,
  buildSlug,
  isOwner,
  timer,
  formatSalesforceValueByDataType,
  formatFieldValuesForSOQL,
  flattenBackupObjects,
  buildSchemaS3Key,
  buildPicklistS3Key,
  buildRecordTypeS3Key,
  buildSchemaKey,
  pickLegacyFieldsKey,
  schemasAreEqual,
  type ISchemaS3KeyParams,
  type ISchemaKeyParams,
  type SchemaKind,
  type S3KeyType
};
