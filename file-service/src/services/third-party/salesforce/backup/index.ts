import { buildFilesS3Keys, toSafeFileName } from "../../../../utils/helper";
import { uploadToS3 } from "../../s3";
import { ICrmFilesJobContext } from "../../types"
import { getContentAsset, getContentBinary, getContentDocument, getContentDocumentLinks, getContentVersion } from "../attachments";
import { SalesforceTokens } from "../common";

interface IBackupFileContent extends ICrmFilesJobContext {
    rows: Record<string, string>[]
}

const updateBackupFiles = async (context: IBackupFileContent) => {
    const { job, backupConfig, source, destination, rows } = context;
    const { backupJobId } = job;
    if (!rows.length) return;
    const recordsIds = rows.map((r) => r.Id);

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

    // S3 keys for storing content file
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
    if (!contentDocumentIds.length) return;
    await uploadToS3(
        destination,
        `${filesKeys.mapping.contentDocumentLink}/${Date.now()}.json`,
        JSON.stringify(contentDocumentLinks.records),
        'application/json'
    );

    const contentDocument = await getContentDocument(salesforce, contentDocumentIds);
    if (!contentDocument.records.length) return;
    await uploadToS3(
        destination,
        `${filesKeys.mapping.contentDocument}/${Date.now()}.json`,
        JSON.stringify(contentDocument.records),
        'application/json'
    );

    const contentDocumentAsset = await getContentAsset(salesforce, contentDocumentIds);
    if (!contentDocumentAsset.records.length) return;
    await uploadToS3(
        destination,
        `${filesKeys.mapping.contentAssets}/${Date.now()}.json`,
        JSON.stringify(contentDocumentAsset.records),
        'application/json'
    );

    const contentVersions = await getContentVersion(salesforce, contentDocumentIds);
    if (!contentVersions.records.length) return;
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

export {
    updateBackupFiles
}