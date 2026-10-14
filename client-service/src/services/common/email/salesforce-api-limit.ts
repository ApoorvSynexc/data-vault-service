import { EMAIL_APP_URL } from '../../../constant';
import { IEmailTemplate, renderEmail } from './render';

export interface ISalesforceApiLimitEmailParams {
  recipientName?: string;
  crmName: string;
  max: number;
  used: number;
  remaining: number;
  percentageUsed: number;
  thresholdPercentage: number;
}

export const buildSalesforceApiLimitEmail = (params: ISalesforceApiLimitEmailParams): IEmailTemplate => {
  const { recipientName, crmName, max, used, remaining, percentageUsed, thresholdPercentage } = params;

  return {
    subject: `Action needed: Salesforce API limit reached for ${crmName}`,
    html: renderEmail({
      contentTemplate: 'salesforce-api-limit',
      locals: {
        recipientName: recipientName ?? 'there',
        crmName,
        max,
        used,
        remaining,
        percentageUsed,
        thresholdPercentage,
      },
      preheader: `Salesforce API usage for ${crmName} has crossed your ${thresholdPercentage}% threshold`,
      heading: 'Salesforce API limit reached',
      ctaLabel: 'Review API usage',
      ctaUrl: `${EMAIL_APP_URL}/settings`,
      accent: 'danger',
    }),
  };
};
