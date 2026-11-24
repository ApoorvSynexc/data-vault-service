import { downloadFromS3, listS3Objects, uploadToS3 } from '../s3';
import { ICrmFilesHandler } from '../types';
import { parseCsvStream } from '../../../utils/csv';
import { buildFilesS3Keys, buildS3KeyPrefix, toSafeFileName } from '../../../utils/helper';
import {
  getContentAsset,
  getContentBinary,
  getContentDocument,
  getContentDocumentLinks,
  getContentVersion,
} from './attachments';
import { SalesforceTokens } from './common';

export const salesforceHandler: ICrmFilesHandler = {
  backupFiles: async ({ job, backupConfig, source, destination }) => {
    const { backupJobId } = job;

    // One token holder per job, so a 401 refresh is shared by every Salesforce call below.
    const salesforce = {
      instanceUrl: source.instanceUrl,
      tokens: {
        accessToken: source.access_token,
        refreshToken: source.refresh_token,
        crmId: source.crmId,
        backupConfigId: backupConfig.backupConfigId,
        userId: backupConfig.userId,
        jobId: backupJobId,
        jobType: 'BACKUP',
      } as SalesforceTokens,
    };

    for (const object of job.object ?? []) {
      if (!object.completedRecordCount) continue;

      const prefix = buildS3KeyPrefix({
        crmId: job.crmId || '',
        crmName: source.crmName,
        backupConfigId: backupConfig.backupConfigId,
        backupJobId,
        objectName: object.name,
        type: 'backup',
        operation: 'inserts',
      });

      const fileList = await listS3Objects(destination, prefix);
      if (fileList.length === 0) continue;

      let rowCount = 0;
      const rows: Record<string, string>[] = [];
      for (const key of fileList) {
        const fileStream = await downloadFromS3(destination, key);
        for await (const row of parseCsvStream(fileStream)) {
          rowCount++;

          if (['001dN0000166firQAA', '001dN0000166fm4QAA'].includes(row.Id)) {
            rows.push(row);
          }
        }
      }

      if (rows.length) {
        const recordsIds = rows.map((r) => r.Id);

        const filesKeys = buildFilesS3Keys({
          crmId: job.crmId || '',
          crmName: source.crmName,
          backupConfigId: backupConfig.backupConfigId,
          backupJobId,
          type: 'backup',
        });

        // upload content document links
        const contentDocumentLinks = await getContentDocumentLinks(salesforce, recordsIds);
        const contentDocumentIds = contentDocumentLinks.records.map((r) => r.ContentDocumentId);
        if (!contentDocumentIds.length) continue;
        await uploadToS3(
          destination,
          `${filesKeys.mapping.contentDocumentLink}/${Date.now()}.json`,
          JSON.stringify(contentDocumentLinks.records),
          'application/json'
        );

        const contentDocument = await getContentDocument(salesforce, contentDocumentIds);
        if (!contentDocument.records.length) continue;
        await uploadToS3(
          destination,
          `${filesKeys.mapping.contentDocument}/${Date.now()}.json`,
          JSON.stringify(contentDocument.records),
          'application/json'
        );

        const contentDocumentAsset = await getContentAsset(salesforce, contentDocumentIds);
        if (!contentDocumentAsset.records.length) continue;
        await uploadToS3(
          destination,
          `${filesKeys.mapping.contentAssets}/${Date.now()}.json`,
          JSON.stringify(contentDocumentAsset.records),
          'application/json'
        );

        const contentVersions = await getContentVersion(salesforce, contentDocumentIds);
        if (!contentVersions.records.length) continue;
        await uploadToS3(
          destination,
          `${filesKeys.mapping.contentVersion}/${Date.now()}.json`,
          JSON.stringify(contentVersions.records),
          'application/json'
        );

        for (const contentVersion of contentVersions.records) {
          const recordFiles = filesKeys.files(contentVersion.ContentDocumentId);

          // upload files
          const fileName = toSafeFileName(contentVersion.Title, contentVersion.FileExtension);
          const fileFolder = contentVersion.IsLatest
            ? `${recordFiles.latest}/${contentVersion.Id}`
            : `${recordFiles.versions}/${contentVersion.Id}`;
          const binary = await getContentBinary(salesforce, contentVersion.Id);
          await uploadToS3(destination, `${fileFolder}/${fileName}`, binary);
        }
      }
    }
  },
};
