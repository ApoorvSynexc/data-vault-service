import { Router } from 'express';
import { crmController } from '../../controller';

const router = Router();

router.get('/list', crmController.crmListHandler);
router.get('/connect', crmController.crmLoginHanlder);
router.get('/callback', crmController.crmCodeHanlder);
router.delete('/disconnect', crmController.crmDisconnectHandler);

export const crmRouter = router;
