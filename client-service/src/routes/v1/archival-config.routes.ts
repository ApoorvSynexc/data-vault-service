import { Router } from 'express';
import { archivalConfigController } from '../../controller';
import { createArchivalConfigValidation } from '../../middlewares';

const router = Router();

router.get('/object-childs', archivalConfigController.getObjectChildHanlder);
router.get('/fields', archivalConfigController.getFieldsHanlder);
router.get('/list', createArchivalConfigValidation, archivalConfigController.listArchivalConfigsHandler);
router.post('/', createArchivalConfigValidation, archivalConfigController.createArchivalConfigHandler);

export const archivalRouter = router;
