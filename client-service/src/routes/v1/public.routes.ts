import { Router } from 'express';
import { publicController } from '../../controller';
import { attachDecryptedSalesforceRequest, salesforceApiKeyAuth } from '../../middlewares';

const router = Router();

router.post('/test', publicController.testHandler);
router.post('/payload', publicController.payloadHandler);
router.post('/backup-trigger', publicController.eventBridgeHandler);
router.put('/webhook/salesforce', salesforceApiKeyAuth, attachDecryptedSalesforceRequest('body'), publicController.salesForceRealTimeHandler);

export const publicRouter = router;
