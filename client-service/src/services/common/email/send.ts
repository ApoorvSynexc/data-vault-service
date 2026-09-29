import { EMAIL_TEMPLATE } from '../../../constant';
import { dispatchMail } from './transport';
import { buildRealtimeTriggerFailureEmail, IRealtimeTriggerFailureEmailParams } from './realtime-trigger-failure';

// Discriminated union keyed on EMAIL_TEMPLATE — picking a template fixes
// which `params` shape TypeScript will accept. Mirrors backup-service's own
// send.ts (the two services don't share a package); only one template exists
// here today, but the shape leaves room to add more the same way.
export type SendEmailPayload = {
  template: typeof EMAIL_TEMPLATE.realtimeTriggerFailure;
  params: IRealtimeTriggerFailureEmailParams;
};

// A plain if/switch-per-case isn't needed yet — EMAIL_TEMPLATE has exactly
// one member today. When a second template is added, turn SendEmailPayload
// into a real discriminated union (see backup-service's own send.ts for the
// pattern) and switch on payload.template here.
const buildEmail = (payload: SendEmailPayload) => buildRealtimeTriggerFailureEmail(payload.params);

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
