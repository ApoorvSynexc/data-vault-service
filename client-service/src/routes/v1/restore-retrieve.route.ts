import { Router } from 'express';
import { restoreRetrieveJobController } from '../../controller';

const router = Router();

router.get('/fetch-logs', restoreRetrieveJobController.fetchLogsHandler);
router.get('/snapshot-logs', restoreRetrieveJobController.getSnapshotActivityLogsHandler);
router.get('/list', restoreRetrieveJobController.listRestoreRetrieveJobsHandler);
router.get('/', restoreRetrieveJobController.getRestoreRetrieveJobHandler);

export const restoreRetrieveRouter = router;
