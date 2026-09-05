import { BACKUP_SERVICE, INTERNAL_SECRET } from '../../../../constant';
import { logger } from '../../../../middlewares';
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

  console.log(JSON.stringify({ payload }));

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

  logger.info("Restore Job has been trigger");
  return result;
};

const createRollbackService = async (
  restoreJob: IRestoreJob,
) => {
  let result;
  const payload = {
    userId: restoreJob.userId,
    restoreJobId: restoreJob.restoreJobId,
    source: restoreJob.source,
    destination: { ...restoreJob.destination },
    conflict: restoreJob.conflict,
    ...(restoreJob.objectHierarchy && { objectHierarchy: restoreJob.objectHierarchy }),
  }

  console.log(JSON.stringify({ payload }));
  try {
    result = await httpRequest({
      url: `${BACKUP_SERVICE}/v1/restore/rollback`,
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    logger.error(`Rollback Job has been failed, ${error}`);
  }

  logger.info("Rollback Job has been trigger");
};

export {
  sendRestoreToBackupService,
  createRollbackService
};

export * from './field-creation';