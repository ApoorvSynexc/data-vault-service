import { getCrmById, getCrmTokens } from '../../crm';
import { salesforceRequest } from '../salesforce';

const getApexObjects = async (crmId: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/accessible-objects`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
  // return JSON.parse(
  //   decrypt({ ciphertext: encryptedResult.data.cipherText, iv: encryptedResult.data.iv })
  // );
};

const getApexObjectsCount = async (crmId: string, body: object) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }
  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-record-count`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

const getApexFields = async (crmId: string, objectName: string) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/object-fields-metadata?objectApiName=${objectName}`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'GET' },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
  // return JSON.parse(
  //   decrypt({ ciphertext: encryptedResult.data.cipherText, iv: encryptedResult.data.iv })
  // );
};

const createApexSecret = async (crmId: string, body: { webhookSecret: string }) => {
  const crm = await getCrmById(crmId);
  if (!crm) {
    throw new Error('CRM not found');
  }

  const { access_token, refresh_token } = getCrmTokens(crm);
  const instanceUrl = crm.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error('Instance URL not found');
  }

  const url = `${instanceUrl}/services/apexrest/SYX_DVV/v1/data-vault/upsert-webhook-secret`;
  const encryptedResult = await salesforceRequest(
    { url, method: 'POST', body: JSON.stringify(body) },
    { accessToken: access_token, refreshToken: refresh_token, crmId, userId: crm.userId, environment: crm.environment, customUrl: crm.customUrl }
  );
  return encryptedResult.data;
};

export { getApexObjects, getApexObjectsCount, getApexFields, createApexSecret };
