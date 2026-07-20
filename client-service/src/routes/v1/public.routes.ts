import { Router } from 'express';
import { publicController } from '../../controller';
import { attachDecryptedSalesforceRequest } from '../../middlewares';

const router = Router();

router.post('/payload', publicController.payloadHandler);
router.post('/backup-trigger', publicController.eventBridgeHandler);
router.put('/webhook/salesforce', attachDecryptedSalesforceRequest('body'), publicController.salesForceRealTimeHandler);

export const publicRouter = router;
