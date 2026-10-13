import { decrypt } from '../../../utils/encryption';
import { getSettingsByUser } from '../../settings';
import { getUser } from '../../user';
import { salesforceRequest, SalesforceTokens } from './api-request';

const SALESFORCE_METADATA_API_VERSION = 'v66.0';

interface ISalesforceLimit {
  Max: number;
  Remaining: number;
}

type SalesforceOrgLimits = Record<string, ISalesforceLimit>;

class SalesforceApiLimitExceededError extends Error {
  constructor() {
    super('Salesforce API limit exceeded');
    this.name = 'SalesforceApiLimitExceededError';
  }
}

const getSalesforceOrgLimits = async (
  instanceUrl: string,
  tokens: SalesforceTokens
): Promise<SalesforceOrgLimits> => {
  return salesforceRequest<SalesforceOrgLimits>(
    { url: `${instanceUrl}/services/data/${SALESFORCE_METADATA_API_VERSION}/limits`, method: 'GET' },
    tokens
  );
};

interface ISalesforceApiLimitUsageParams {
  backupConfigId: string;
  userId?: string;

  instanceUrl?: string;
  tokens?: SalesforceTokens;

  thresholdPercentage?: number;
}

const checkSalesforceApiLimitUsage = async (params: ISalesforceApiLimitUsageParams) => {
  const { userId, backupConfigId } = params;
  let { instanceUrl, tokens, thresholdPercentage = 80 } = params;

  if (!instanceUrl && !tokens && userId) {
    const user = await getUser(userId);
    if (!user || !user.crmId || !user.crmCredential || !user.crmProfile?.instanceUrl) {
      throw new Error('User not found');
    }

    const source = JSON.parse(decrypt(user.crmCredential)) as { access_token: string; refresh_token: string };
    instanceUrl = user.crmProfile.instanceUrl;
    tokens = {
      accessToken: source.access_token,
      refreshToken: source.refresh_token,
      crmId: user.crmId,
      backupConfigId,
    };
  }

  if (userId) {
    const settings = await getSettingsByUser(userId);
    if (settings) {
      thresholdPercentage = settings.salesforceApiThreshold ?? 80;
    }
  }

  if (!instanceUrl || !tokens) {
    throw new Error('[Salesforce API Limit Usage] Instance URL or tokens not provided');
  }

  const limits = await getSalesforceOrgLimits(instanceUrl, tokens);
  const dailyApiRequests = limits.DailyApiRequests;
  if (!dailyApiRequests) {
    throw new Error('DailyApiRequests limit not returned by Salesforce');
  }

  const { Max: max, Remaining: remaining } = dailyApiRequests;
  const used = max - remaining;
  const percentageUsed = max > 0 ? Number(((used / max) * 100).toFixed(2)) : 0;

  if (percentageUsed > thresholdPercentage) {
    throw new SalesforceApiLimitExceededError();
  }

  return { max, remaining, used, percentageUsed };
};

export { checkSalesforceApiLimitUsage, SalesforceApiLimitExceededError };
export type { ISalesforceApiLimitUsageParams };
