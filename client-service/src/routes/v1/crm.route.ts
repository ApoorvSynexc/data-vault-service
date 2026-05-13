import { Router } from 'express';
import { crmController } from '../../controller';
import { updateCrmValidation } from '../../middlewares';

const router = Router();

router.get('/list', crmController.crmListHandler);
router.put('/', updateCrmValidation, crmController.updateCrmHandler);
router.get('/connect', crmController.crmLoginHanlder);
router.get('/callback', crmController.crmCodeHanlder);
router.delete('/disconnect', crmController.crmDisconnectHandler);
router.delete('/', crmController.crmDeleteHandler);
router.get('/refresh-token', crmController.crmRefreshTokenHandler);

export const crmRouter = router;
