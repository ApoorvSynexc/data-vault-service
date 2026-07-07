import { Router } from 'express';
import { publicController } from '../../controller';
import { authorizeController } from '../../controller/v1/public/authorize';
import { webhookAuth, authorizeOrganizationValidation, authorizeUserValidation, attachDecryptedSalesforceRequest } from '../../middlewares';

const router = Router();

router.get('/payload', publicController.payloadHandler);
router.post('/backup-trigger', publicController.eventBridgeHandler);
router.put('/webhook/salesforce', webhookAuth, publicController.salesForceRealTimeHandler);
router.post('/authorize-org', authorizeOrganizationValidation, authorizeController.authorizeOrganizationHandler);
router.post('/authorize-admin', authorizeUserValidation, attachDecryptedSalesforceRequest('body'), authorizeController.authorizeUserHandler);

export const publicRouter = router;
