import { Router } from 'express';
import { publicController } from '../../controller';

const router = Router();

router.get('/webhook/salesforce', publicController.salesForceealTimeHandler);

export const publicRouter = router;
