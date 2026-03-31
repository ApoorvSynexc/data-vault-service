import { Router } from 'express';
import { internalController } from '../../controller';

const router = Router();

router.get('/fields', internalController.getFieldsHanlder);
router.get('/refresh-token', internalController.crmRefreshTokenHandler);
router.get('/backup-payload', internalController.getBackupServicePayloadHandler);

export const internalRouter = router;
