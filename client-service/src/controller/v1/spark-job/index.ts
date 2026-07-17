import { IRequest, IResponse, makeResponse } from '../../../lib';
import { buildPayload } from '../../../services/payload';
import { wrapController } from '../../../utils/helper';
import { decryptFromTransport, encryptToTransport } from '../../../utils/encryption';
import { logger } from '../../../middlewares';

/**
 * POST /spark-job/build-payload
 * Body:     { payload: "<encrypted-string>" }   → decrypts to { backupConfigId }
 * Response: { payload: "<encrypted-built-payload>" }
 *
 * Decrypts the request, builds the EMR payload, and returns it re-encrypted.
 * The raw built payload (which contains destination credentials) is never returned.
 */
const buildPayloadHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { payload } = req.body as { payload?: unknown };

  if (!payload || typeof payload !== 'string') {
    return makeResponse(req, res, 400, false, 'params_required');
  }

  let backupConfigId: string | undefined;
  try {
    ({ backupConfigId } = JSON.parse(decryptFromTransport(payload)));
    logger.info('payload decrypted');
  } catch (error) {
    logger.error('payload decryption failed:', error);
    return makeResponse(req, res, 400, false, 'invalid_payload');
  }

  if (!backupConfigId) {
    return makeResponse(req, res, 400, false, 'id_required');
  }

  const built = await buildPayload(backupConfigId);
  const encrypted = encryptToTransport(JSON.stringify(built));
  logger.info('payload built and encrypted');

  return makeResponse(req, res, 200, true, 'fetch', { payload: encrypted });
};

export const sparkJobController = wrapController({ buildPayloadHandler });
