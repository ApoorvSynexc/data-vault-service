import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
import { EMAIL_COMPANY_NAME, EMAIL_SUPPORT_ADDRESS } from '../../../constant';

export interface IEmailTemplate {
  subject: string;
  html: string;
}

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// Reads straight from disk on every call rather than caching — these are
// low-volume transactional emails, not a hot path, and this keeps a template
// edit picked up without a redeploy of the compiled service.
const readTemplate = (name: string): string => fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.ejs`), 'utf8');

interface IRenderEmailParams {
  // Filename (no extension) under ./templates — the small partial with this
  // email's own copy, e.g. 'backup-job-failure'.
  contentTemplate: string;
  // Locals for the content partial. EJS's <%= %> HTML-escapes by default, so
  // any of these that came from user input (object/config names, error
  // messages) is safe to interpolate directly — no manual escaping needed.
  locals: Record<string, unknown>;
  preheader: string;
  heading: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

// Renders one of the templates/<name>.ejs content partials, then wraps the
// result in templates/layout.ejs (shared header/footer/branding). EJS has no
// block-inheritance, so composing this way — render the content first, pass
// its output into the layout as a local — is the standard workaround.
export const renderEmail = (params: IRenderEmailParams): string => {
  const { contentTemplate, locals, preheader, heading, ctaLabel, ctaUrl } = params;

  const contentPath = path.join(TEMPLATES_DIR, `${contentTemplate}.ejs`);
  const bodyHtml = ejs.render(readTemplate(contentTemplate), locals, { filename: contentPath });

  const layoutPath = path.join(TEMPLATES_DIR, 'layout.ejs');
  return ejs.render(
    readTemplate('layout'),
    {
      companyName: EMAIL_COMPANY_NAME,
      supportAddress: EMAIL_SUPPORT_ADDRESS,
      year: new Date().getFullYear(),
      preheader,
      heading,
      bodyHtml,
      ctaLabel,
      ctaUrl,
    },
    { filename: layoutPath }
  );
};
