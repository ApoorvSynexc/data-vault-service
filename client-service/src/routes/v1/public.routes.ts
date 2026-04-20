import { Router } from 'express';
import { publicController } from '../../controller';
import { webhookAuth } from '../../middlewares';

const router = Router();

router.put('/webhook/salesforce', webhookAuth, publicController.salesForceealTimeHandler);

export const publicRouter = router;
