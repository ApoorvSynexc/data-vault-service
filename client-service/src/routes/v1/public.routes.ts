import { Router } from 'express';
import { publicController } from '../../controller';
import { webhookAuth } from '../../middlewares';

const router = Router();

router.put('/backup-trigger', publicController.eventBridgeHandler);
router.put('/webhook/salesforce', webhookAuth, publicController.salesForceRealTimeHandler);

export const publicRouter = router;
