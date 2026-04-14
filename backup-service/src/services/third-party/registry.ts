import { CRM_NAME } from '../../constant';
import { ICrmBackupHandler, ICrmRealtimeHandler } from './types';
import { salesforceHandler } from './salesforce/handler';
import { salesforceRealtimeHandler } from './salesforce/realtime';

const crmRegistry: Record<string, ICrmBackupHandler> = {
  [CRM_NAME.salesforce]: salesforceHandler,
  // [CRM_NAME.zoho]: zohoHandler,
};

const realtimeCrmRegistry: Record<string, ICrmRealtimeHandler> = {
  [CRM_NAME.salesforce]: salesforceRealtimeHandler,
  // [CRM_NAME.zoho]: zohoRealtimeHandler,
};

export const getCrmHandler = (crmName: string): ICrmBackupHandler => {
  const handler = crmRegistry[crmName];
  if (!handler) {
    throw new Error(`Unsupported CRM: ${crmName}`);
  }
  return handler;
};

export const getRealtimeCrmHandler = (crmName: string): ICrmRealtimeHandler => {
  const handler = realtimeCrmRegistry[crmName];
  if (!handler) {
    throw new Error(`Unsupported CRM for realtime: ${crmName}`);
  }
  return handler;
};
