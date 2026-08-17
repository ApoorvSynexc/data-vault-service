import { Router } from 'express';
import { crmMetadataController } from '../../controller';
import { getMasterObjectsValidation } from '../../middlewares';

const router = Router();

router.get('/object-schema', crmMetadataController.getSalesforceObjectSchema);
router.get('/objects/list', crmMetadataController.getsalesfroceObjects);
router.post('/objects/master/list', getMasterObjectsValidation, crmMetadataController.getSalesforceMasterObjects);
router.get('/fields/list', crmMetadataController.getsalesfrocefields);

export const crmMetadataRouter = router;
