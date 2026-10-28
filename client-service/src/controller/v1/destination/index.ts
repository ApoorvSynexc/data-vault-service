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
import { IS3Config } from '../../../models';
import { buildRoleSetup, isRoleSetupConfigured } from '../../../services/third-party/s3-bucket/role-setup';
import {
  resolveBucketRegion,
  runStagedRoleConnectionTest,
  validateS3Credentials,
} from '../../../services/third-party/s3-bucket';


const createDestinationHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { name, provider, type, config, is_already_granted } = req.body;
  const userId = req.user!.userId;

  // Legacy destinations hold the customer's access keys; role destinations hold a role ARN + External ID.
  const isRoleDestination = config?.authType === 'ASSUME_ROLE';
  const hasCredentials = isRoleDestination
    ? Boolean(config?.roleArn && config?.externalId)
    : Boolean(config?.accessKeyId && config?.secretAccessKey);
  const isS3WithCreds = type === 'S3' && Boolean(config?.bucketName && config?.region) && hasCredentials;
  const athenaCreds = config as IS3Config;

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


  // A role destination is deliberately NOT given permission to edit the customer's bucket policy
  // (least privilege), so we never auto-grant for it. The customer pastes the statement from the
  // setup guide, and `athenaAccessGranted: false` tells the screen to remind them.
  let athenaAccessGranted = true;
  if (isRoleDestination && !is_already_granted) {
    athenaAccessGranted = false;
  }
  if (!is_already_granted && isS3WithCreds && !isRoleDestination) {
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

// GET /destination/role-setup?bucketName=...&folderPath=...
// Gives the setup guide everything to show: DataCraft's account, a fresh External ID, and the
// policies / CloudFormation template to use in the customer's AWS account.
const getRoleSetupHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const bucketName = String(req.query.bucketName ?? '').trim();
  const folderPath = req.query.folderPath ? String(req.query.folderPath) : undefined;

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) {
    makeResponse(req, res, 400, false, 'invalid_bucket_name');
    return;
  }
  if (!isRoleSetupConfigured()) {
    logger.error('[destination] role setup requested but DATACRAFT_AWS_ACCOUNT_ID is not set (needs a 12-digit AWS account id)');
    makeResponse(req, res, 500, false, 'role_setup_not_configured');
    return;
  }

  makeResponse(req, res, 200, true, 'fetch', buildRoleSetup({ userId: req.user!.userId, bucketName, folderPath }));
};

// GET /destination/resolve-bucket-region?bucketName=...&region=...
const resolveBucketRegionHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const bucketName = String(req.query.bucketName ?? '').trim();
  const claimedRegion = req.query.region ? String(req.query.region).trim() : undefined;

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) {
    makeResponse(req, res, 400, false, 'invalid_bucket_name');
    return;
  }

  try {
    const result = await resolveBucketRegion(bucketName, claimedRegion);
    makeResponse(req, res, 200, true, 'fetch', result);
  } catch (err) {
    logger.warn(
      `[destination] bucket region resolve failed | bucket:${bucketName} claimed:${claimedRegion ?? '-'} err:${(err as Error)?.message}`
    );
    makeResponse(req, res, 400, false, 'bucket_region_unresolved');
  }
};

// POST /destination/test-connection  (same body as create)
// Runs assume-role → bucket → write → read checks in order; nothing is saved.
const testConnectionHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const userId = req.user!.userId;
  const config = req.body.config as IS3Config;

  if (config?.authType === 'ASSUME_ROLE') {
    const result = await runStagedRoleConnectionTest(config, userId);
    if (!result.connected) {
      makeResponse(
        req,
        res,
        400,
        false,
        (result.failureReason || 'connection_test_failed') as any,
        result
      );
      return;
    }
    makeResponse(req, res, 200, true, 'fetch', result);
    return;
  }

  // Legacy access-key destinations: single validate, no staged UI.
  try {
    await validateS3Credentials(config);
    makeResponse(req, res, 200, true, 'fetch', {
      connected: true,
      checks: [
        { id: 'assume_role', status: 'skipped' },
        { id: 'bucket_access', status: 'passed' },
        { id: 'write_object', status: 'skipped' },
        { id: 'read_object', status: 'skipped' },
      ],
    });
  } catch {
    logger.warn(`[destination] key connection failed | userId:${userId} bucket:${config?.bucketName}`);
    makeResponse(req, res, 400, false, 'invalid_aws_credentials');
  }
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
  makeResponse(req, res, 200, true, 'fetch', { ...config, accessKeyId: undefined, secretAccessKey: undefined, sessionToken: undefined });
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
  getRoleSetupHandler,
  resolveBucketRegionHandler,
  testConnectionHandler,
  createDestinationHandler,
  listDestinationsHandler,
  getDestinationHandler,
  getDestinationConfigHandler,
  updateDestinationHandler,
  deleteDestinationHandler,
});
