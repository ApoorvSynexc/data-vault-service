import { Router } from 'express';
import { crmMetadataController } from '../../controller';

const router = Router();

router.get('/all-objects/list', crmMetadataController.getSalesforceObjectsHandler);
router.get('/objects/list', crmMetadataController.getsalesfroceObjects);
router.get('/objects/describe', crmMetadataController.getSalesforceDescribeObject);
router.get('/object/depth-children', crmMetadataController.getSalesforceDepthChildren);
router.get('/fields/list', crmMetadataController.getSalesforceFields);
router.get('/record-types/list', crmMetadataController.getSalesforceRecordTypes);

export const crmMetadataRouter = router;
