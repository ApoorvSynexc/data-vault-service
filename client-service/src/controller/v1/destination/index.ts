import { IRequest, IResponse, makeResponse } from '../../../lib';
import {
  createDestination,
  deleteDestination,
  getDestinationById,
  getDestinationsByUser,
  getDecryptedDestinationConfig,
  updateDestination,
} from '../../../services';
import { wrapController } from '../../../utils/helper';
import { grantAthenaRoleS3Access, checkAthenaRoleS3Access } from '../../../services/third-party/athena';
import { logger } from '../../../middlewares';

const createDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { name, provider, type, config, is_already_granted } = req.body;
  const userId = req.user!.userId;

  const athenaCreds = { bucketName: config?.bucketName, region: config?.region, accessKeyId: config?.accessKeyId, secretAccessKey: config?.secretAccessKey };
  const isS3WithCreds = type === 'S3' && athenaCreds.bucketName && athenaCreds.region && athenaCreds.accessKeyId && athenaCreds.secretAccessKey;

  // Client claims they granted Athena access manually — verify their bucket
  // policy actually carries our statement before creating the destination.
  // Bail out (no dangling destination) if it's missing.
  if (is_already_granted && isS3WithCreds) {
    const granted = await checkAthenaRoleS3Access(athenaCreds).catch(() => false);
    if (!granted) {
      makeResponse(req, res, 400, false, 'athena_access_not_granted');
      return;
    }
  }

  const destination = await createDestination({
    userId,
    name,
    provider,
    type,
    config,
  });


  let athenaAccessGranted = true;
  if (!is_already_granted && isS3WithCreds) {
    try {
      await grantAthenaRoleS3Access(athenaCreds);
    } catch (err: any) {
      athenaAccessGranted = false;
      logger.error(`[destination] failed to grant Athena role S3 access | destinationId:${destination.destinationId} err:${err?.message ?? err}`);
    }
  }

  makeResponse(req, res, 201, true, 'create', {
    ...destination,
    athenaAccessGranted,
    cipherText: undefined,
    authTag: undefined,
    iv: undefined,
  });
};

const listDestinationsHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

  const result = await getDestinationsByUser(userId, { limit, cursor });
  const { documents, nextCursor } = result;

  for (let index = 0; index < documents.length; index++) {
    const element = documents[index];
    const config = getDecryptedDestinationConfig(element);
    (documents[index] as any).bucketName = config.bucketName;
    (documents[index] as any).region = config.region;
  }

  makeResponse(
    req,
    res,
    200,
    true,
    'fetch',
    documents.map((d) => ({ ...d, cipherText: undefined, iv: undefined, authTag: undefined })),
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
  const isOwner = destination && destination.userId === req.user!.userId;

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', {
    ...destination,
    cipherText: undefined,
    authTag: undefined,
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
  const isOwner = destination && destination.userId === req.user!.userId;

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const config = getDecryptedDestinationConfig(destination!);
  makeResponse(req, res, 200, true, 'fetch', { ...config, accessKeyId: undefined, secretAccessKey: undefined });
};

const updateDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { destinationId } = req.query;

  if (!destinationId) {
    makeResponse(req, res, 400, false, 'destination_id_required');
    return;
  }

  const userId = req.user!.userId;
  const destination = await getDestinationById(String(destinationId));
  const isOwner = destination && destination.userId === userId;

  if (!isOwner) {
    makeResponse(req, res, 400, false, 'not_exist');
    return;
  }

  const updated = await updateDestination(String(destinationId), req.body, userId);

  makeResponse(req, res, 200, true, 'update', {
    ...updated,
    cipherText: undefined,
    authTag: undefined,
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
  const isOwner = destination && destination.userId === req.user!.userId;

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
