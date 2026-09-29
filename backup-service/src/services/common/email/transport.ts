import nodemailer, { Transporter } from 'nodemailer';
import { EMAIL_SMTP_USER, EMAIL_SMTP_APP_PASSWORD, EMAIL_FROM_ADDRESS, EMAIL_COMPANY_NAME } from '../../../constant';
import { logger } from '../../../middlewares/logger';

// Built lazily (not at import time) so a missing EMAIL_SMTP_* env var only
// breaks the actual send call, not every import of this module (tests,
// scripts, other services/common code that has nothing to do with email).
let transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  if (!EMAIL_SMTP_USER || !EMAIL_SMTP_APP_PASSWORD) {
    throw new Error(
      'Email transport not configured — set EMAIL_SMTP_USER and EMAIL_SMTP_APP_PASSWORD (a Gmail App Password, not the account login password).'
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: EMAIL_SMTP_USER,
        pass: EMAIL_SMTP_APP_PASSWORD,
      },
    });
  }
  return transporter;
};

export interface ISendMailPayload {
  to: string | string[];
  subject: string;
  html: string;
}

// Thin wrapper around nodemailer's sendMail — the actual template selection
// lives in ./send.ts (sendEmail), this is just "given a rendered {subject,
// html}, deliver it." Kept separate so a future provider swap (SES, Postmark,
// ...) only touches this file, not every template builder.
export const dispatchMail = async ({ to, subject, html }: ISendMailPayload): Promise<void> => {
  try {
    const info = await getTransporter().sendMail({
      from: `${EMAIL_COMPANY_NAME} <${EMAIL_FROM_ADDRESS || EMAIL_SMTP_USER}>`,
      to,
      subject,
      html,
    });
    logger.info(`[email] sent | to:${Array.isArray(to) ? to.join(',') : to} subject:"${subject}" messageId:${info.messageId}`);
  } catch (err: any) {
    logger.error(`[email] send failed | to:${Array.isArray(to) ? to.join(',') : to} subject:"${subject}" err:${err?.message ?? err}`);
    throw err;
  }
};
