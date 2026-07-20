import { Router } from 'express';
import { sparkJobController } from '../../controller';

const router = Router();

router.post('/build-payload', sparkJobController.buildPayloadHandler);
router.post('/update-spark-job-status', sparkJobController.updateSparkJobStatusHandler);

export const sparkRouter = router;
