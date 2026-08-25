import { Router } from 'express';
import { sparkJobController } from '../../controller';

const router = Router();

router.post('/build-payload', sparkJobController.buildPayloadHandler);
router.post('/update-spark-job-status', sparkJobController.updateSparkJobStatusHandler);
router.get('/get-inactive-owner-ids', sparkJobController.getInactiveOwnerIdsHandler);
router.get('/restore-fields', sparkJobController.getRestoreFieldsHandler);
router.get('/restore-objects', sparkJobController.getRestoreObjectsHandler);

export const sparkRouter = router;
