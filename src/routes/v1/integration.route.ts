import { Router } from 'express';
import { integratioController } from '../../controller';

const router = Router();

router.get('/list', integratioController.integrationListHandler);
router.get('/connect', integratioController.integrationLoginHanlder);
router.get('/callback', integratioController.integrationCodeHanlder);
router.delete('/disconnect', integratioController.integrationDisconnectHandler);

export const integrationRouter = router;
