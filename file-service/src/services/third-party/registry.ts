import { CRM_NAME } from '../../constant';
import { ICrmFilesHandler } from './types';
import { salesforceHandler } from './salesforce/handler';

const crmRegistry: Record<string, ICrmFilesHandler> = {
  [CRM_NAME.salesforce]: salesforceHandler,
  // [CRM_NAME.zoho]: zohoHandler,
};

export const getCrmHandler = (crmName: string): ICrmFilesHandler => {
  const handler = crmRegistry[crmName];
  if (!handler) {
    throw new Error(`Unsupported CRM: ${crmName}`);
  }
  return handler;
};
