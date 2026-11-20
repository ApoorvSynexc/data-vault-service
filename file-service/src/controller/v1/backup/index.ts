import { Request, Response } from 'express';
import {
  getBackupConfig,
  getBackupJob,
  listS3Objects,
  downloadFromS3,
  getContentDocumentLinks,
  SalesforceTokens,
  getContentVersion,
  getContentBinary,
  uploadToS3,
} from '../../../services';
import { makeResponse } from '../../../lib/response';
import { parseCsvStream } from '../../../utils/csv';
import { IBackupConfig, IDestinationConfig, ISource } from '../../../models';
import { decrypt } from '../../../utils/encryption';
import { buildS3KeyPrefix, toSafeFileName, wrapController } from '../../../utils/helper';

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

      const attachmentPrefix =  buildS3KeyPrefix({
        crmId: job.crmId || "",
        crmName: source.crmName,
        backupConfigId: backupConfig.backupConfigId,
        backupJobId,
        objectName: object.name,
        type: 'backup',
      });

      // Files linked to each of the sampled rows, saved under
      //   <attachmentPrefix>/attachments/<recordId>/content-document-links.json
      //   <attachmentPrefix>/attachments/<recordId>/<contentDocumentId>/content-version.json
      //   <attachmentPrefix>/attachments/<recordId>/<contentDocumentId>/<Title>.<ext>
      const links = [];
      for (const row of rows) {
        if (!row.Id) continue;
        const recordFolder = `${attachmentPrefix}/attachments/${row.Id}`;

        const contentDocumentLinks = await getContentDocumentLinks(salesforce, row.Id);
        if (!contentDocumentLinks.records.length) continue;

        await uploadToS3(
          destination,
          `${recordFolder}/content-document-links.json`,
          JSON.stringify(contentDocumentLinks.records),
          'application/json'
        );

        const contentDocumentVersions = [];
        for (const { ContentDocumentId } of contentDocumentLinks.records) {
          const contentVersion = await getContentVersion(salesforce, ContentDocumentId);
          if (!contentVersion) continue;
          contentDocumentVersions.push(contentVersion);

          // const documentFolder = `${recordFolder}/${ContentDocumentId}_old_${Date.now()}`;
          // await uploadToS3(
          //   destination,
          //   `${documentFolder}/content-version.json`,
          //   JSON.stringify(contentVersion),
          //   'application/json'
          // );

          // const binary = await getContentBinary(salesforce, contentVersion.Id);
          // await uploadToS3(
          //   destination,
          //   `${documentFolder}/${toSafeFileName(contentVersion.Title, contentVersion.FileExtension)}`,
          //   binary
          // );
        }

        links.push({ ...row, contentDocumentLinks, contentDocumentVersions });
      }

      payload.push({
        prefix,
        fileList,
        rowCount,
        rows,
        links,
      });
    }
  }

  makeResponse(req, res, 200, true, 'fetch', payload);
};

export const backupController = wrapController({ getBackupHandler });
