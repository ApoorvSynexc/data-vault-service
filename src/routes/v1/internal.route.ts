import { Router } from 'express';
import { internalController } from '../../controller';

const router = Router();

router.get('/fields', internalController.getFieldsHanlder);
router.get('/refresh-token', internalController.crmRefreshTokenHandler);

export const internalRouter = router;
