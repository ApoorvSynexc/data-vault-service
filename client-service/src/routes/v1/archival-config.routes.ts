import { Router } from 'express';
import { archivalConfigController } from '../../controller';
import { createArchivalConfigValidation, dryRunArchivalValidation } from '../../middlewares';

const router = Router();

router.get('/object-childs', archivalConfigController.getObjectChildHanlder);
router.get('/fields', archivalConfigController.getFieldsHanlder);
router.get('/list', archivalConfigController.listArchivalConfigsHandler);
router.get('/', archivalConfigController.getArchivalConfigHandler);
router.get('/stats', archivalConfigController.getArchivalJobStatsHandler);
router.put('/', archivalConfigController.updateArchivalConfigHandler);
router.delete('/', archivalConfigController.deletearchivalConfigHandler);
router.post('/dry-run', dryRunArchivalValidation, archivalConfigController.dryRunArchivalHandler);
router.post('/', createArchivalConfigValidation, archivalConfigController.createArchivalConfigHandler);

export const archivalRouter = router;
