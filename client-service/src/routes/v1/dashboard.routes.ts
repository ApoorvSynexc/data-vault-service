import { Router } from 'express';
import { dashboardController } from '../../controller';

const router = Router();

router.get('/overview', dashboardController.overviewV2Handler);
router.get('/last-jobs', dashboardController.getLastBackupJob);
router.get('/global-search', dashboardController.globalSearchHandler);

export const dashboardRouter = router;
