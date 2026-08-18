import { Router } from 'express';
import { restoreRetrieveJobController } from '../../controller';
import { createRestoreValidation } from '../../middlewares';

/**
 * Restore & Retrieve routes — all require authentication (applied at the parent router level).
 *
 * GET  /list                            — paginated list of restore/retrieve jobs (by config or user)
 * GET  /get-objectlist-by-configid      — object list selected on a single backup config
 * GET  /fetch-change-between-backup-jobs — backupJobIds of a config that started inside a time window
 * POST /retrieve/fetch-records          — records for one object out of the compressed Hudi/Delta
 *                                         tables: ENTIRE, or CHANGED_BETWEEN a date window, each row
 *                                         tagged with the OPERATION a restore would perform
 * GET  /fetch-object-fields             — latest S3 schema for objectApiName across the (single)
 *                                         backup config shared by the given backupJobIds
 * GET  /                                — single restore/retrieve job (by backupJobId)
 */
const router = Router();

router.post('/', createRestoreValidation, restoreRetrieveJobController.createRestoreHandler);
router.post('/activate', restoreRetrieveJobController.activateRestoreHandler);
router.get('/config/list', restoreRetrieveJobController.listRestoresHandler);
router.get('/job', restoreRetrieveJobController.getRestoreJobHandler);
router.get('/job/stats', restoreRetrieveJobController.getRestoreJobStatsHandler);
router.get('/list', restoreRetrieveJobController.listRestoreRetrieveJobsHandler);
router.get('/get-objectlist-by-configid', restoreRetrieveJobController.getObjectListByConfigIdHandler);
router.get(
  '/fetch-change-between-backup-jobs',
  restoreRetrieveJobController.fetchChangeBetweenBackupJobsHandler
);
router.post('/retrieve/fetch-records', restoreRetrieveJobController.fetchRecordsHandler);
router.post('/retrieve/fetch-inactive-record-types', restoreRetrieveJobController.fetchInactiveRecordTypesHandler);
router.get('/fetch-object-fields', restoreRetrieveJobController.fetchObjectFieldsHandler);
router.get('/get-picklist-field-values', restoreRetrieveJobController.getPicklistFieldValuesHandler);
router.get('/restore', restoreRetrieveJobController.getRestoreRetrieveJobHandler);

export const restoreRetrieveRouter = router;
