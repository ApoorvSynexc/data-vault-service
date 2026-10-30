const SALESFORCE_PRODUCTION_BASE = 'https://login.salesforce.com';
const SALESFORCE_SANDBOX_BASE = 'https://test.salesforce.com';

type SalesforceEnvironment = 'production' | 'sandbox' | 'custom';

const getSalesforceBaseUrl = (environment?: SalesforceEnvironment, customUrl?: string): string => {
  if (environment === 'sandbox') {
    return SALESFORCE_SANDBOX_BASE;
  }
  if (environment === 'custom') {
    if (!customUrl) {
      throw new Error('customUrl is required for custom environment');
    }
    return customUrl.replace(/\/$/, '');
  }
  return SALESFORCE_PRODUCTION_BASE;
};

const getSalesforceUrls = (environment?: SalesforceEnvironment, customUrl?: string) => {
  const base = getSalesforceBaseUrl(environment, customUrl);
  return {
    authUrl: `${base}/services/oauth2/authorize`,
    tokenUrl: `${base}/services/oauth2/token`,
    profileUrl: `${base}/services/oauth2/userinfo`,
  };
};

export { getSalesforceUrls };
export type { SalesforceEnvironment };
