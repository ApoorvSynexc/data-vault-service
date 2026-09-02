import { BACKUP_SERVICE, INTERNAL_SECRET } from '../../../../constant';
import { IRestoreJob } from '../../../../models';
import { httpRequest } from '../../../../utils/http-request';

const sendRestoreToBackupService = async (
  restorejob: IRestoreJob,
) => {
  let result;
  const payload = {
    userId: restorejob.userId,
    restoreJobId: restorejob.restoreJobId,
    source: restorejob.source,
    destination: { ...restorejob.destination },
    conflict: restorejob.conflict,
    ...(restorejob.objectHierarchy && { objectHierarchy: restorejob.objectHierarchy }),
  }
  try {
    result = await httpRequest({
      url: `${BACKUP_SERVICE}/v1/restore`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.log("Restore Job has been failed, ", { error });
    throw error;
  }

  console.log("Restore Job has been trigger to backup service");
  return result;
};

export {
  sendRestoreToBackupService,
};

export * from './field-creation';