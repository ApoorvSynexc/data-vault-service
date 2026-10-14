import { EMAIL_TEMPLATE } from '../../../constant';
import { dispatchMail } from './transport';
import { buildRealtimeTriggerFailureEmail, IRealtimeTriggerFailureEmailParams } from './realtime-trigger-failure';
import { buildSalesforceApiLimitEmail, ISalesforceApiLimitEmailParams } from './salesforce-api-limit';

// Discriminated union keyed on EMAIL_TEMPLATE — picking a template fixes
// which `params` shape TypeScript will accept. Mirrors backup-service's own
// send.ts (the two services don't share a package).
export type SendEmailPayload =
  | {
      template: typeof EMAIL_TEMPLATE.realtimeTriggerFailure;
      params: IRealtimeTriggerFailureEmailParams;
    }
  | {
      template: typeof EMAIL_TEMPLATE.salesforceApiLimitReached;
      params: ISalesforceApiLimitEmailParams;
    };

const buildEmail = (payload: SendEmailPayload) => {
  switch (payload.template) {
    case EMAIL_TEMPLATE.realtimeTriggerFailure:
      return buildRealtimeTriggerFailureEmail(payload.params);
    case EMAIL_TEMPLATE.salesforceApiLimitReached:
      return buildSalesforceApiLimitEmail(payload.params);
  }
};

/**
 * sendEmail(to, { template: EMAIL_TEMPLATE.realtimeTriggerFailure, params }) —
 * renders the matching template (see ./send.ts's SendEmailPayload union for
 * which `params` shape each EMAIL_TEMPLATE member expects) and delivers it
 * via the configured SMTP transport (./transport.ts).
 */
export const sendEmail = async (to: string | string[], payload: SendEmailPayload): Promise<void> => {
  const { subject, html } = buildEmail(payload);
  await dispatchMail({ to, subject, html });
};
