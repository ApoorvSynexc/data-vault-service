import { IRequest, IResponse, makeResponse } from "../../../lib";
import { downloadFromS3, getApexFields, getApexObjects, getBackupConfigById, getCrmById, getDecryptedDestinationConfig, getDestinationById, getUsersByContactEmail, getUsersByCrmId, listS3Objects } from "../../../services";
import { buildSchemaS3Key, wrapController } from "../../../utils/helper";


const getSalesforceObjectSchema = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { backupConfigId, objetName } = req.query;

  const crm = await getCrmById(user.crmId!);
  if (!crm) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const backupConfig = await getBackupConfigById(String(backupConfigId));
  if (!backupConfig) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const destination = await getDestinationById(backupConfig.destinationId);
  if (!destination) {
    return makeResponse(req, res, 400, false, 'not_exist');
  }

  const schemaKey = buildSchemaS3Key({
    crmId: user.crmId!,
    objectName: String(objetName),
    crmName: String(crm.name),
    backupConfigId: String(backupConfigId),
    type: backupConfig.type === 'NORMAL' ? 'backup' : 'archival'
  });

  const destConfig = getDecryptedDestinationConfig(destination);
  const s3Config = {
    bucketName: destConfig.bucketName,
    region: destConfig.region,
    accessKeyId: destConfig.accessKeyId,
    secretAccessKey: destConfig.secretAccessKey,
  };

  const schemaFolder = schemaKey.replace('/fields.json', '/');
  const allSchemaKeys = await listS3Objects(s3Config, schemaFolder);
  const versionedKeys = allSchemaKeys.filter((k) => /fields_\d+\.json$/.test(k));
  const currentSchemaKey = versionedKeys.length > 0 ? versionedKeys[versionedKeys.length - 1] : schemaKey;
  const existingSchemaBuffer = await downloadFromS3(s3Config, currentSchemaKey);
  const schemaJson = existingSchemaBuffer ? JSON.parse(existingSchemaBuffer.toString()) : {}
  makeResponse(req, res, 200, true, 'fetch', schemaJson);
};

const getsalesfroceObjects = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { crmId, mode } = req.query;

  if (!user.contactEmail) {
    return makeResponse(req, res, 400, false, 'unauthorized');
  }

  if (crmId) {
    const crmUsers = await getUsersByContactEmail({ contactEmail: user.contactEmail });
    if (!crmUsers) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const crmUser = crmUsers.find((u) => u.crmId === String(crmId));
    if (!crmUser) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const objects = await getApexObjects({ user: crmUser, mode: mode ? String(mode) : undefined })
    const result = objects?.data ? objects.data : [];
    return makeResponse(req, res, 200, true, 'fetch', result);
  }

  const objects = await getApexObjects({ user, mode: mode ? String(mode) : undefined })
  const result = objects?.data ? objects.data : [];
  return makeResponse(req, res, 200, true, 'fetch', result);
}

const getsalesfrocefields = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { crmId, objectName, mode } = req.query;

  if (!user.contactEmail) {
    return makeResponse(req, res, 400, false, 'unauthorized');
  }

  if (crmId) {
    const crmUsers = await getUsersByContactEmail({ contactEmail: user.contactEmail });
    if (!crmUsers) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const crmUser = crmUsers.find((u) => u.crmId === String(crmId));
    if (!crmUser) {
      return makeResponse(req, res, 400, false, 'not_exist');
    }

    const objects = await getApexFields({ user: crmUser, objectName: String(objectName), mode: mode ? String(mode) : undefined })
    return makeResponse(req, res, 200, true, 'fetch', objects);
  }

  const objects = await getApexFields({ user, objectName: String(objectName), mode: mode ? String(mode) : undefined })
  return makeResponse(req, res, 200, true, 'fetch', objects);
}

export const crmMetadataController = wrapController({
  getSalesforceObjectSchema,
  getsalesfroceObjects,
  getsalesfrocefields
});