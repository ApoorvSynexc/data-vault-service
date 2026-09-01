import { Router } from 'express';
import { internalController } from '../../controller';
import { internalAuth } from '../../middlewares';

const router = Router();

router.use(internalAuth);

router.get('/refresh-token', internalController.crmRefreshTokenHandler);
router.post('/backup-payload', internalController.getBackupServicePayloadHandler);

export const internalRouter = router;
