import { downloadFromS3, listS3Objects } from '../s3';
import { ICrmFilesHandler } from '../types';
import { parseCsvStream } from '../../../utils/csv';
import { buildS3KeyPrefix } from '../../../utils/helper';
import { updateBackupFiles } from './backup';

export const salesforceHandler: ICrmFilesHandler = {
  backupFiles: async ({ job, backupConfig, source, destination }) => {
    const { backupJobId } = job;

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

      let cursor: string | undefined;
      do {
        const page = await listS3Objects(destination, prefix, 1000, cursor);

        let rows: Record<string, string>[] = [];
        for (const key of page.keys) {
          const fileStream = await downloadFromS3(destination, key);

          for await (const row of parseCsvStream(fileStream)) {

            if (['001dN0000166firQAA', '001dN0000166fm4QAA'].includes(row.Id)) {
              rows.push(row);
            }

            if (rows.length >= 2) {
              await updateBackupFiles({ job, backupConfig, source, destination, rows });
              rows = [];
            }
          }
        }

        cursor = page.nextCursor;
      } while (cursor);
    }
  },
};
