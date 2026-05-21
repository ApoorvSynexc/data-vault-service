import { Router } from 'express';
import { dashboardController } from '../../controller';

const router = Router();

router.get('/overview', dashboardController.overviewHandler);
router.get('/last-jobs', dashboardController.getLastBackupJob);

export const dashboardRouter = router;
