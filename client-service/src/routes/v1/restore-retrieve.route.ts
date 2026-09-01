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
 * POST /retrieve/fetch-inactive-record-types — Record Types made inactive or deleted inside a date window
 * POST /retrieve/fetch-missing-fields   — fields the backup config's stored S3 schema has that the
 *                                         destination object's live Salesforce fields do not
 * POST /retrieve/fetch-missing-record-types — record types, grouped by object, that the backup's
 *                                         history flagged inactive/deleted and are still missing or
 *                                         inactive on the destination org right now
 * POST /retrieve/required-fields        — one object's required fields after restore field
 *                                         filtering (restore-writable, non-system, required-on-create)
 * GET  /fetch-object-fields             — latest S3 schema for objectApiName across the (single)
 *                                         backup config shared by the given backupJobIds
 * POST /dry-run                         — record counts a restore configuration would touch
 *                                         (ENTIRE: main Hudi only; CHANGED_BETWEEN: delta
 *                                         total/UPDATE/DELETE) — read-only, no restore is performed
 * POST /dry-run-diff                    — the same configuration, but returning the records
 *                                         themselves instead of counts, each paired with the
 *                                         destination org's current version of that record
 *                                         ({changeRecord, salesforceRecord}). Capped per object;
 *                                         read-only, no restore is performed
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
router.post('/retrieve/fetch-missing-fields', restoreRetrieveJobController.fetchMissingFieldsHandler);
router.post('/retrieve/fetch-missing-record-types', restoreRetrieveJobController.fetchMissingRecordTypesHandler);
router.post('/retrieve/required-fields', restoreRetrieveJobController.requiredFieldsHandler);
router.get('/fetch-object-fields', restoreRetrieveJobController.fetchObjectFieldsHandler);
router.post('/dry-run', restoreRetrieveJobController.dryRunHandler);
router.post('/dry-run-diff', restoreRetrieveJobController.dryRunDiffHandler);
router.get('/get-picklist-field-values', restoreRetrieveJobController.getPicklistFieldValuesHandler);
router.get('/restore', restoreRetrieveJobController.getRestoreRetrieveJobHandler);

export const restoreRetrieveRouter = router;
