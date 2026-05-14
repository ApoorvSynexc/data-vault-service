import { Router } from 'express';
import { dashboardController } from '../../controller';

const router = Router();

router.get('/overview', dashboardController.getOverviewHandler);

export const dashboardRouter = router;
