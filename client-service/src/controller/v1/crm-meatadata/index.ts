import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getApexFields, getApexObjects, toApexMode, toApexType, getBackupConfigById, getCrmById, getDecryptedDestinationConfig, getDestinationById, getUsersByContactEmail, getUsersByCrmId, readSchemaFile } from "../../../services";
import { ISalesforceObjectDescribeResponse, salesforceObjectDescribe, salesforceObjectFilteredList, salesforceObjectList, salesforceObjectsCount } from "../../../services/third-party/salesforce/metadata/index";
import { wrapController } from "../../../utils/helper";


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

  const destConfig = getDecryptedDestinationConfig(destination);
  const s3Config = {
    bucketName: destConfig.bucketName,
    region: destConfig.region,
    accessKeyId: destConfig.accessKeyId,
    secretAccessKey: destConfig.secretAccessKey,
  };

  // Latest version from schema/main/{object}/fields/, legacy folder as fallback.
  const schemaJson = await readSchemaFile(s3Config, {
    crmId: user.crmId!,
    objectName: String(objetName),
    crmName: String(crm.name),
    backupConfigId: String(backupConfigId),
    type: backupConfig.type === 'NORMAL' ? 'backup' : 'archival',
    kind: 'fields',
  });
  makeResponse(req, res, 200, true, 'fetch', schemaJson ?? {});
};

const getsalesfroceObjects = async (req: IRequest, res: IResponse) => {
  let user = req.user!;
  const { crmId, mode, type } = req.query;
  const apexMode = toApexMode(mode) ?? 'backup';
  const apexType = toApexType(type ?? mode);

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

    user = crmUser;
  }

  const objectsCount = await salesforceObjectsCount({ user });
  let filteredObjects = await salesforceObjectFilteredList({ user, apexMode, apexType });
  filteredObjects = filteredObjects
    .map((obj) => {
      const countObj = objectsCount.find((count) => count.name === obj.name);
      return {
        ...obj,
        count: countObj?.count || 0
      };
    })
    .sort((a, b) => b.count - a.count);

  return makeResponse(req, res, 200, true, 'fetch', filteredObjects);
}

const getSalesforceDescribeObject = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { objectName, mode, type } = req.query;

  if (!objectName) {
    return makeResponse(req, res, 400, false, 'object_name_required');
  }

  const apexMode = toApexMode(mode) ?? 'backup';
  const apexType = toApexType(type ?? mode);

  const filteredObjects = await salesforceObjectFilteredList({ user, apexMode, apexType });
  const filteredObjectNames = filteredObjects.map((obj) => obj.name);
  const objectDescription = await salesforceObjectDescribe({ user, objectName: String(objectName) });
  const children = objectDescription.childRelationships
    .filter((child) => filteredObjectNames.includes(child.childSObject) && child.childSObject !== objectName && child.cascadeDelete)
    .map((child) => ({ name: child.childSObject }));

  // const parentFields = objectDescription.fields.filter((field) => field.type === 'reference');
  // const parent: { [key: string]: string | boolean }[] = [];
  // parentFields.forEach((field) => {
  //   field.referenceTo.forEach((ref) => {
  //     if (filteredObjectNames.includes(ref)) {
  //       parent.push({ name: ref, nillable: field.nillable, cascadeDelete: field.cascadeDelete });
  //     }
  //   })
  // })
  return makeResponse(req, res, 200, true, 'fetch', { children });
}

const getSalesforceMasterObjects = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  const { objectNames } = req.body;

  const notAllowedNames = ['ownerid', 'createdbyid', 'lastmodifiedbyid', 'lastreferencedid', 'lastviewedid'];

  const objectDescriptions = await Promise.all<ISalesforceObjectDescribeResponse>(
    objectNames.map((objectName: string) => salesforceObjectDescribe({ user, objectName }))
  );

  const masterObjects = objectDescriptions.filter((objectDescription) => {
    const field = objectDescription.fields.find((f) => f.type === 'reference' && (f.relationshipOrder !== null) && !notAllowedNames.includes(f.name.toLowerCase()));
    return !field;
  });

  return makeResponse(req, res, 200, true, 'fetch', masterObjects);
}

const getsalesfrocefields = async (req: IRequest, res: IResponse) => {
  const user = req.user!;
  // Field metadata is mode-only — schedule vs realtime does not change the fields.
  const { crmId, objectName, mode } = req.query;
  const apexMode = toApexMode(mode) ?? 'backup';

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

    const objects = await getApexFields({ user: crmUser, objectName: String(objectName), mode: apexMode })
    const result = objects?.data ? objects.data : [];
    return makeResponse(req, res, 200, true, 'fetch', result);
  }

  const objects = await getApexFields({ user, objectName: String(objectName), mode: apexMode })
  const result = objects?.data ? objects.data : [];
  return makeResponse(req, res, 200, true, 'fetch', result);
}

export const crmMetadataController = wrapController({
  getSalesforceObjectSchema,
  getsalesfroceObjects,
  getsalesfrocefields,
  getSalesforceMasterObjects,
  getSalesforceDescribeObject
});