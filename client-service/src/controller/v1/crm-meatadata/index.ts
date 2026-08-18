import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getApexFields, getApexObjects, toApexMode, toApexType, getBackupConfigById, getCrmById, getDecryptedDestinationConfig, getDestinationById, getUsersByContactEmail, getUsersByCrmId, readSchemaFile } from "../../../services";
import { ISalesforceObjectDescribeResponse, salesforceObjectDescribe, salesforceObjectList, salesforceObjectsCount } from "../../../services/third-party/salesforce/metadata/index";
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
  const excludeObjectSuffix = ['__x', '__mdt', '__share', '__history', '__feed', '__tag', '__tagset', '__comment', '__changeevent', '__e', '__et', 'share', 'history', 'feed', 'tag', 'tagset', 'comment', 'changeevent', 'e', 'et'];
  const excludeObjects = [
    'address',
    'attachment',
    'document',
    'contentnote',
    'contentdocumentlink',
    'ideacomment',
    'vote',
    'brandtemplate',
    'apexcomponent',
    'weblink',
    'categorynode',
    'devopsactivitylog',
    'apexclass',
    'callcenter',
    'emailservicesaddress',
    'apextrigger',
    'apexpage',
    'fiscalyearsettings',
    'orgemailaddresssecurity',
    'chatteractivity',
    'orgwideemailaddress',
    'notificationmember',
    'period',
    'businesshours',
    'organization',
    'userrole',
    'devopsactivitylogfeed',
    'queuesobject',
    'businessprocess',
    'profile',
    'forecastingadjustment',
    'groupsubscription',
    'staticresource',
    'groupmember',
    'holiday',
    'sfdcpartnersbscroffer',
    'user',
    'folder',
    'group',
    'forecastingitem',
    'forecastingquota',
    'sfdcpartnersbscrofferitem',
    'slackchannelrelatedrecord',
    'topic',
    'collaborationgroupmember',
    'devopsrequestinfo',
    'emailservicesfunction',
    'emailtemplate',
    'recordtype'
  ];
  const objectsList = await salesforceObjectList({ user });
  const objectsCount = await salesforceObjectsCount({ user });
  let filteredObjects = objectsList.filter((obj) =>
    obj.deprecatedAndHidden === false &&
    obj.customSetting === false &&
    obj.retrieveable === true &&
    obj.replicateable === true &&
    obj.updateable === true &&
    obj.createable === true &&
    obj.deletable === true &&
    obj.keyPrefix !== null &&
    obj.queryable === true &&
    !excludeObjectSuffix.some((suffix) => obj.name.toLowerCase().endsWith(suffix)) &&
    !excludeObjects.includes(obj.name.toLowerCase())
  );

  if (apexMode === 'backup' && apexType === 'realtime') {
    filteredObjects = filteredObjects.filter((obj) => obj.triggerable === true);
  } else if (apexMode === 'archival') {
    filteredObjects = filteredObjects.filter((obj) => obj.deletable === true);
  } else if (apexMode === 'restore') {
    filteredObjects = filteredObjects.filter((obj) => obj.createable === true && obj.updateable === true);
  }

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
  getSalesforceMasterObjects
});