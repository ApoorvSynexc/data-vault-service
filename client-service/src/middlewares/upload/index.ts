import multer from 'multer';
import { NextFunction } from 'express';
import { IRequest, IResponse, makeResponse } from '../../lib';

// 5MB is generous for a plain list of Salesforce record Ids (even at 18 chars/id
// + newline, that's well over 100k rows) while still bounding memory — the file
// is buffered in memory (see storage below), never written to disk.
const MAX_CSV_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    if (isCsv) {
      callback(null, true);
    } else {
      callback(new Error('invalid_file_type'));
    }
  },
});

// Wraps multer's single-file parse in this app's own JSON response format.
// There's no global Express error-handling middleware in this service (only the
// per-controller asyncHandler wrapper — see utils/helper.ts), and multer runs
// as its own middleware ahead of the controller in the route chain, so a
// MulterError (oversized file, unexpected extra file) or our fileFilter's
// rejection would otherwise fall through to Express's default HTML error page
// instead of the consistent makeResponse JSON shape every other endpoint uses.
export const uploadSingleCsv = (fieldName: string) =>
  (req: IRequest, res: IResponse, next: NextFunction): void => {
    csvUpload.single(fieldName)(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          makeResponse(req, res, 400, false, 'file_too_large');
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          makeResponse(req, res, 400, false, 'too_many_files');
          return;
        }
      }

      if (err instanceof Error && err.message === 'invalid_file_type') {
        makeResponse(req, res, 400, false, 'invalid_file_type');
        return;
      }

      makeResponse(req, res, 400, false, 'upload_failed');
    });
  };
