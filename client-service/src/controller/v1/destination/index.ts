import { access } from 'node:fs';
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
  if (!destination || destination.userId !== req.user!.userId) {
    makeResponse(req, res, 400, false, 'not_found');
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
  if (!destination || destination.userId !== req.user!.userId) {
    makeResponse(req, res, 400, false, 'not_found');
    return;
  }

  const config = getDecryptedDestinationConfig(destination);
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
  if (!destination || destination.userId !== userId) {
    makeResponse(req, res, 400, false, 'not_found');
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
  if (!destination || destination.userId !== req.user!.userId) {
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
