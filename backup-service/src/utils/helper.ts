import { IRequest, IResponse, makeResponse } from '../lib';

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

const SALESFORCE_TO_PARQUET_TYPE: Record<string, string> = {
  STRING: 'BYTE_ARRAY',
  ID: 'BYTE_ARRAY',
  REFERENCE: 'BYTE_ARRAY',
  PICKLIST: 'BYTE_ARRAY',
  MULTIPICKLIST: 'BYTE_ARRAY',
  TEXTAREA: 'BYTE_ARRAY',
  PHONE: 'BYTE_ARRAY',
  URL: 'BYTE_ARRAY',
  EMAIL: 'BYTE_ARRAY',
  ENCRYPTEDSTRING: 'BYTE_ARRAY',
  COMBOBOX: 'BYTE_ARRAY',
  BASE64: 'BYTE_ARRAY',
  DATE: 'BYTE_ARRAY',
  DATETIME: 'BYTE_ARRAY',
  TIME: 'BYTE_ARRAY',
  BOOLEAN: 'BOOLEAN',
  INTEGER: 'INT32',
  LONG: 'INT64',
  DOUBLE: 'DOUBLE',
  PERCENT: 'DOUBLE',
  CURRENCY: 'DOUBLE',
};

const toParquetDataType = (salesforceDataType: string): string =>
  SALESFORCE_TO_PARQUET_TYPE[salesforceDataType.toUpperCase()] ?? 'BYTE_ARRAY';

type S3KeyOperation = 'inserts' | 'updates' | 'deletes';
type S3KeyType = 'backup' | 'archival';

interface IS3KeyPrefixParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  operation: S3KeyOperation;
  type: S3KeyType;
}

const buildS3KeyPrefix = ({
  crmId,
  crmName,
  backupConfigId,
  objectName,
  operation,
  type,
}: IS3KeyPrefixParams): string => `${crmName}/${crmId}/${type}/${backupConfigId}/raw_data/${objectName}/${operation}`;

interface ISchemaS3KeyParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  objectName: string;
  type: S3KeyType;
}

const buildSchemaS3Key = ({
  crmId,
  crmName,
  backupConfigId,
  objectName,
  type,
}: ISchemaS3KeyParams): string => `${crmName}/${crmId}/${type}/${backupConfigId}/schema/${objectName}/fields.json`;

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
      if (char === '\r') i++; // skip the \n of \r\n
      if (current.trim()) rows.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) rows.push(current);
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
  return fields.map(field => {
    if (!field.filter) {
      return field;
    }

    const formattedValue = formatValueByDataType(field.filter.value, field.dataType);

    return {
      ...field,
      filter: {
        ...field.filter,
        value: formattedValue
      }
    };
  });
};

const formatValueByDataType = (value: string, dataType: string): string => {
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

export {
  randomNumber,
  parseExpiryToSeconds,
  wrapController,
  buildS3KeyPrefix,
  buildSchemaS3Key,
  toParquetDataType,
  schemasAreEqual,
  splitCSVRows,
  parseCSVLine,
  formatFieldValuesForSOQL,
  formatValueByDataType,
  type IS3KeyPrefixParams,
  type ISchemaS3KeyParams,
  type S3KeyType,
};
