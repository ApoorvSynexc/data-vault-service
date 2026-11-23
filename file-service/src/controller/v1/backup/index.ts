import { Request, Response } from 'express';
import {
  getBackupConfig,
  getBackupJob,
  listS3Objects,
  downloadFromS3,
  getContentDocumentLinks,
  SalesforceTokens,
  getContentDocument,
  getContentVersion,
  getContentBinary,
  uploadToS3,
} from '../../../services';
import { makeResponse } from '../../../lib/response';
import { parseCsvStream } from '../../../utils/csv';
import { IBackupConfig, IDestinationConfig, ISource } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { buildFilesS3Keys, buildS3KeyPrefix, toSafeFileName, wrapController } from '../../../utils/helper';

const getBackupHandler = async (req: Request, res: Response): Promise<void> => {
  const { backupJobIds } = req.body as { backupJobIds: string[] };

  const payload = []

  let backupConfig: IBackupConfig | null = null;
  for (let index = 0; index < backupJobIds.length; index++) {
    const backupJobId = backupJobIds[index];
    const job = await getBackupJob(backupJobId);
    if (!job || !job.object) continue;

    if (!backupConfig) {
      backupConfig = await getBackupConfig(job.backupConfigId);
      if (!backupConfig) continue;
    }

    const destination = JSON.parse(decrypt(job.destination)) as IDestinationConfig;
    const source = JSON.parse(decrypt(job.source)) as ISource;

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

    for (let index = 0; index < job.object.length; index++) {
      const object = job.object[index];
      if (!object.completedRecordCount) continue;

      const prefix = buildS3KeyPrefix({
        crmId: job.crmId || "",
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
      const rows = []
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
        const recordsIds = rows.map(r => r.Id);

        const filesKeys = buildFilesS3Keys({
          crmId: job.crmId || "",
          crmName: source.crmName,
          backupConfigId: backupConfig.backupConfigId,
          backupJobId,
          type: 'backup',
        });

        // upload content document links 
        const contentDocumentLinks = await getContentDocumentLinks(salesforce, recordsIds);
        const contentDocumentIds = contentDocumentLinks.records.map(r => r.ContentDocumentId);
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

        const contentVersions = await getContentVersion(salesforce, contentDocumentIds);
        if (!contentVersions.records.length) continue;
        await uploadToS3(
          destination,
          `${filesKeys.mapping.contentVersion}/${Date.now()}.json`,
          JSON.stringify(contentVersions.records),
          'application/json'
        );

        for (let index = 0; index < contentVersions.records.length; index++) {
          const contentVersion = contentVersions.records[index];
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

      payload.push({
        prefix,
        fileList,
        rowCount,
        rows,
      });
    }
  }

  makeResponse(req, res, 200, true, 'fetch', payload);
};

export const backupController = wrapController({ getBackupHandler });
