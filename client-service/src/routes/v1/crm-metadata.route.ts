import { Router } from 'express';
import { crmMetadataController } from '../../controller';
import { getMasterObjectsValidation } from '../../middlewares';

const router = Router();

router.get('/object-schema', crmMetadataController.getSalesforceObjectSchema);
router.get('/objects/list', crmMetadataController.getsalesfroceObjects);
router.get('/objects/describe', crmMetadataController.getSalesforceDescribeObject);
router.post('/objects/master/list', getMasterObjectsValidation, crmMetadataController.getSalesforceMasterObjects);
router.get('/fields/list', crmMetadataController.getSalesforceFields);
router.get('/record-types/list', crmMetadataController.getSalesforceRecordTypes);

export const crmMetadataRouter = router;
