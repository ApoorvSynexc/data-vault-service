import { Router } from 'express';
import { archivalConfigController, restoreRetrieveJobController } from '../../controller';
import { createRestoreValidation } from '../../middlewares';

/**
 * Restore & Retrieve routes — all require authentication (applied at the parent router level).
 *
 * GET  /list                            — paginated list of restore/retrieve jobs (by config or user)
 * GET  /get-objectlist-by-configid      — object list selected on a single backup config
 * POST /fetch-records                   — query Athena records for given backupJobIds, objectApiName,
 *                                         and columnNames
 * GET  /fetch-object-fields             — latest S3 schema for objectApiName across the (single)
 *                                         backup config shared by the given backupJobIds
 * GET  /                                — single restore/retrieve job (by backupJobId)
 */
const router = Router();

router.post('/', createRestoreValidation, restoreRetrieveJobController.createRestoreHandler);
router.get('/list', restoreRetrieveJobController.listRestoreRetrieveJobsHandler);
router.get('/get-objectlist-by-configid', restoreRetrieveJobController.getObjectListByConfigIdHandler);
router.post('/retrieve/fetch-records', restoreRetrieveJobController.fetchRecordsHandler);
router.get('/fetch-object-fields', restoreRetrieveJobController.fetchObjectFieldsHandler);
// Same handler as /archival-config/get-picklist-field-values — identical apex callout.
router.get('/get-picklist-field-values', archivalConfigController.getPicklistFieldValuesHandler);
router.post('/retrieve/repair-glue', restoreRetrieveJobController.repairGlueTablesHandler);
router.get('/restore', restoreRetrieveJobController.getRestoreRetrieveJobHandler);

export const restoreRetrieveRouter = router;
