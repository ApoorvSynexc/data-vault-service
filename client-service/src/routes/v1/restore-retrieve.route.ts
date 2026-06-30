import { Router } from 'express';
import { restoreRetrieveJobController } from '../../controller';

/**
 * Restore & Retrieve routes — all require authentication (applied at the parent router level).
 *
 * GET  /fetch-logs                      — activity log for a specific job (by backupJobId)
 * GET  /snapshot-logs                   — activity log entries for a config scoped to a destination
 * GET  /list                            — paginated list of restore/retrieve jobs (by config or user)
 * GET  /get-objectlist-by-configid      — object list selected on a single backup config
 * GET  /get-objectlist-by-backup-jobids — per-job object lists for backup jobs (SCHEDULE/REALTIME),
 *                                         comma-separated backupJobIds
 * POST /fetch-records                   — query Athena records for given backupJobIds, objectApiName,
 *                                         and columnNames
 * GET  /                                — single restore/retrieve job (by backupJobId)
 */
const router = Router();

router.get('/fetch-logs', restoreRetrieveJobController.fetchLogsHandler);
router.get('/snapshot-logs', restoreRetrieveJobController.getSnapshotActivityLogsHandler);
router.get('/list', restoreRetrieveJobController.listRestoreRetrieveJobsHandler);
router.get('/get-objectlist-by-configid', restoreRetrieveJobController.getObjectListByConfigIdHandler);
router.get('/get-objectlist-by-backup-jobids', restoreRetrieveJobController.getObjectListByBackupJobIdsHandler);
router.get('/get-backup-configs-name', restoreRetrieveJobController.getBackupConfigsNameHandler);
router.post('/retrieve/fetch-records', restoreRetrieveJobController.fetchRecordsHandler);
router.post('/retrieve/repair-glue', restoreRetrieveJobController.repairGlueTablesHandler);
router.get('/restore', restoreRetrieveJobController.getRestoreRetrieveJobHandler);

export const restoreRetrieveRouter = router;
