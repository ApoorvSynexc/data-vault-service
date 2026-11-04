import { Router } from 'express';
import { publicController } from '../../controller';
import { attachDecryptedSalesforceRequest } from '../../middlewares';

const router = Router();

router.post('/test', publicController.testHandler);
router.post('/payload', publicController.payloadHandler);
router.post('/backup-trigger', publicController.eventBridgeHandler);
router.put('/webhook/salesforce', attachDecryptedSalesforceRequest('body'), publicController.salesForceRealTimeHandler);
router.get('/s3-assumerole-role.cfn.yaml', publicController.s3AssumeRoleCfnTemplateHandler);

export const publicRouter = router;
