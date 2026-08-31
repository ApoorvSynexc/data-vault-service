import { IEmailTemplate, renderEmail } from './render';

// Fires when an exported restore file (CSV or PDF) has finished generating
// and is ready to download — the record-retrieval/export flow in
// controller/v1/restore-retrieve (client-service).
export interface IRestoreFileDownloadEmailParams {
  recipientName?: string;
  restoreConfigName?: string;
  backupConfigName: string;
  fileFormat: 'CSV' | 'PDF';
  fileName: string;
  downloadUrl: string;
  // Download links are typically pre-signed S3 URLs with a TTL — surfaced
  // here so the recipient knows to download before it expires.
  expiresInHours?: number;
}

export const buildRestoreFileDownloadEmail = (params: IRestoreFileDownloadEmailParams): IEmailTemplate => {
  const { recipientName, restoreConfigName, backupConfigName, fileFormat, fileName, downloadUrl, expiresInHours } = params;
  const label = restoreConfigName ?? backupConfigName;

  return {
    subject: `Your ${fileFormat} export is ready: ${label}`,
    html: renderEmail({
      contentTemplate: 'restore-file-download',
      locals: { recipientName: recipientName ?? 'there', label, fileFormat, fileName, expiresInHours },
      preheader: `Your ${fileFormat} export for ${label} is ready to download`,
      heading: `Your ${fileFormat} export is ready`,
      ctaLabel: `Download ${fileFormat}`,
      ctaUrl: downloadUrl,
    }),
  };
};
