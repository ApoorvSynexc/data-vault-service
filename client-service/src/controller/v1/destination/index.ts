import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createDestination,
  deleteDestination,
  getDestinationById,
  getDestinationsByUser,
  getDestinationsBySpace,
  getDecryptedDestinationConfig,
  updateDestination,
} from '../../../services';
import { wrapController } from '../../../utils/helper';
import { grantAthenaRoleS3Access } from '../../../services/third-party/athena';
import { logger } from '../../../middlewares';

const createDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { name, provider, type, config } = req.body;
  const userId = req.user!.userId;

  const destination = await createDestination({
    userId,
    name,
    provider,
    type,
    config,
    ...(req.user?.spaceId && { spaceId: req.user.spaceId }),
  });

  // Grant our Athena Role ARN read access to the client's S3 bucket so Athena
  // can query their data. Non-fatal — destination is already saved, policy can
  // be retried. Only applies to S3 destinations that carry bucket credentials.
  if (type === 'S3' && config?.bucketName && config?.region && config?.accessKeyId && config?.secretAccessKey) {
    grantAthenaRoleS3Access({
      bucketName: config.bucketName,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    }).catch((err) =>
      logger.error(`[destination] failed to grant Athena role S3 access | destinationId:${destination.destinationId} err:${err?.message ?? err}`)
    );
  }

  makeResponse(req, res, 201, true, 'create', {
    ...destination,
    ciphertext: undefined,
    iv: undefined,
  });
};

const listDestinationsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const spaceId = req.user?.spaceId;
  const userId = req.user!.userId;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

  let result;
  if (spaceId) {
    result = await getDestinationsBySpace(spaceId, { limit, cursor });
  } else {
    result = await getDestinationsByUser(userId, { limit, cursor });
  }

  const { documents, nextCursor } = result;

  makeResponse(
    req,
    res,
    200,
    true,
    'fetch',
    documents.map((d) => ({ ...d, ciphertext: undefined, iv: undefined })),
    { nextCursor }
  );
};

const getDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { destinationId } = req.query;

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'destination_id_required');
    return;
  }

  const destination = await getDestinationById(String(destinationId));
  const isOwner = destination && (destination.userId === req.user!.userId || destination.spaceId === req.user?.spaceId);

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', {
    ...destination,
    ciphertext: undefined,
    iv: undefined,
  });
};

const getDestinationConfigHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { destinationId } = req.query;

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'destination_id_required');
    return;
  }

  const destination = await getDestinationById(String(destinationId));
  const isOwner = destination && (destination.userId === req.user!.userId || destination.spaceId === req.user?.spaceId);

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const config = getDecryptedDestinationConfig(destination!);
  makeResponse(req, res, 200, true, 'fetch', {...config, accessKeyId: undefined, secretAccessKey: undefined});
};

const updateDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { destinationId } = req.query;

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'destination_id_required');
    return;
  }

  const userId = req.user!.userId;
  const destination = await getDestinationById(String(destinationId));
  const isOwner = destination && (destination.userId === userId || destination.spaceId === req.user?.spaceId);

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const updated = await updateDestination(String(destinationId), req.body, userId);

  makeResponse(req, res, 200, true, 'update', {
    ...updated,
    ciphertext: undefined,
    iv: undefined,
  });
};

const deleteDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { destinationId } = req.query;

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'destination_id_required');
    return;
  }

  const destination = await getDestinationById(String(destinationId));
  const isOwner = destination && (destination.userId === req.user!.userId || destination.spaceId === req.user?.spaceId);

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  await deleteDestination(String(destinationId));
  makeResponse(req, res, 200, true, 'delete');
};

export const destinationController = wrapController({
  createDestinationHandler,
  listDestinationsHandler,
  getDestinationHandler,
  getDestinationConfigHandler,
  updateDestinationHandler,
  deleteDestinationHandler,
});
