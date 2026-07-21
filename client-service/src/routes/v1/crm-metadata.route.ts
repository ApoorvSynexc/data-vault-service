import { Router } from 'express';
import { crmMetadataController } from '../../controller';

const router = Router();

router.get('/object-schema', crmMetadataController.getSalesforceObjectSchema);
router.get('/objects/list', crmMetadataController.getsalesfroceObjects);
router.get('/fields/list', crmMetadataController.getsalesfrocefields);

export const crmMetadataRouter = router;
