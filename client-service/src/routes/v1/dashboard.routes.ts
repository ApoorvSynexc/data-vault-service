import { Router } from 'express';
import { dashboardController } from '../../controller';

const router = Router();

router.get('/overview', dashboardController.overviewHandler);

export const dashboardRouter = router;
