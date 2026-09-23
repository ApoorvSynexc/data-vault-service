import { IRequest, IResponse, makeResponse } from '../../lib';
import { logger } from '../logger';

type IHandler = (req: IRequest, res: IResponse) => Promise<void>;

// Dedicated error handler for the archival-record-preview APIs, kept in its
// own folder (mirrors the per-domain layout under middlewares/gateway/permissions)
// rather than reusing utils/helper.ts's shared asyncHandler, so this domain's
// error behavior can't be affected by, or accidentally affect, any other
// controller's.
//
// Differs from the shared asyncHandler in one deliberate way: it never
// forwards a raw AWS SDK error message to the client (a Glue/Athena error can
// carry the SQL text, table/database name, or bucket path) — those go to the
// server log only, keyed by error name where recognisable, and the response
// carries a generic, stable code instead.
const isAwsThrottling = (error: any): boolean =>
  error?.name === 'ThrottlingException' ||
  error?.name === 'TooManyRequestsException' ||
  error?.$metadata?.httpStatusCode === 429;

const isAwsAccessDenied = (error: any): boolean =>
  error?.name === 'AccessDeniedException' ||
  error?.name === 'UnauthorizedException';

const asyncArchivalPreviewHandler =
  (fn: IHandler): IHandler =>
    async (req: IRequest, res: IResponse): Promise<void> => {
      try {
        await fn(req, res);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[archival-record-preview] ${req.method} ${req.originalUrl} : ${message}`);

        // Cast, not a real localization key — same "raw string falls through
        // as the message" fallback makeResponse already applies to any
        // unrecognised key, matching the pattern the shared asyncHandler in
        // utils/helper.ts already relies on.
        if (isAwsThrottling(error)) {
          makeResponse(req, res, 429, false, 'too_many_requests' as Parameters<typeof makeResponse>[4]);
          return;
        }
        if (isAwsAccessDenied(error)) {
          makeResponse(req, res, 502, false, 'upstream_access_denied' as Parameters<typeof makeResponse>[4]);
          return;
        }
        makeResponse(req, res, 500, false, 'internal_error' as Parameters<typeof makeResponse>[4]);
      }
    };

const wrapArchivalPreviewController = <T extends Record<string, IHandler>>(controller: T): T =>
  Object.fromEntries(Object.entries(controller).map(([key, fn]) => [key, asyncArchivalPreviewHandler(fn)])) as T;

export { asyncArchivalPreviewHandler, wrapArchivalPreviewController };
