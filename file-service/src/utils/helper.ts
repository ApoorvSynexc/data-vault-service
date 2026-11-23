import { Request, Response } from 'express';
import { makeResponse } from '../lib/response';

type IHandler = (req: Request, res: Response) => Promise<void>;

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

const asyncHandler =
  (fn: IHandler): IHandler =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error: unknown) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : 'unknown_error';
      console.error(`[${statusCode}] ${req.method} ${req.originalUrl} : ${message}`);
      makeResponse(
        req,
        res,
        statusCode,
        false,
        (message || 'unknown_error') as Parameters<typeof makeResponse>[4]
      );
    }
  };

// Wraps every handler of a controller so thrown errors become a failure response
// instead of an unhandled rejection.
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

interface IFilesS3KeyParams {
  crmId: string;
  crmName: string;
  backupConfigId: string;
  backupJobId: string;
  type: S3KeyType;
}

// Folder layout for Salesforce Files, a sibling of raw_data under the backup config:
//
//   <crmName>/<crmId>/<type>/<backupConfigId>/
//     files/<recordId>/latest/                      current file of the record
//     files/<recordId>/versions/                    older versions of the file
//     Files-mapping/<backupJobId>/content_document_link/
//     Files-mapping/<backupJobId>/content_version/
//     Files-mapping/<backupJobId>/content_document/
//     Files-mapping/<backupJobId>/content_assets/
//
// S3 has no real folders, so this returns the key prefixes (no trailing slash);
// append a file name to a prefix to get the object key.
const buildFilesS3Keys = ({ crmId, crmName, backupConfigId, backupJobId, type }: IFilesS3KeyParams) => {
  const base = `${crmName}/${crmId}/${type}/${backupConfigId}`;
  const mapping = `${base}/Files-mapping/${backupJobId}`;

  return {
    files: (recordId: string) => ({
      latest: `${base}/files/${recordId}/latest`,
      versions: `${base}/files/${recordId}/versions`,
    }),
    mapping: {
      contentDocumentLink: `${mapping}/content_document_link`,
      contentVersion: `${mapping}/content_version`,
      contentDocument: `${mapping}/content_document`,
      contentAssets: `${mapping}/content_assets`,
    },
  };
};

// "<Title>.<ext>" with characters that are unsafe in an S3 key / file name replaced,
// so a Salesforce title like "a/b" can't create extra folders.
const toSafeFileName = (title: string, extension?: string | null): string => {
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
  return extension ? `${safeTitle}.${extension}` : safeTitle;
};

export { buildS3KeyPrefix, buildFilesS3Keys, toSafeFileName, wrapController };
