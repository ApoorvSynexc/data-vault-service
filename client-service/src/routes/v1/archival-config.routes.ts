import { Router } from 'express';
import { archivalConfigController } from '../../controller';
import { createArchivalConfigValidation, dryRunArchivalValidation, validateSoqlArchivalValidation } from '../../middlewares';

const router = Router();

router.post('/object-records', archivalConfigController.getObjectRecordsHanlder);
// router.get('/get-picklist-field-values', archivalConfigController.getPicklistFieldValuesHandler);

router.get('/list', archivalConfigController.listArchivalConfigsHandler);
router.get('/', archivalConfigController.getArchivalConfigHandler);
router.get('/stats', archivalConfigController.getArchivalJobStatsHandler);
router.put('/', archivalConfigController.updateArchivalConfigHandler);
router.delete('/', archivalConfigController.deletearchivalConfigHandler);
router.get('/run-now', archivalConfigController.runNowArchivalConfigHandler);
router.post('/dry-run', dryRunArchivalValidation, archivalConfigController.dryRunArchivalHandler);
router.post('/validate-soql', validateSoqlArchivalValidation, archivalConfigController.validateSoqlArchivalHandler);
router.post('/', createArchivalConfigValidation, archivalConfigController.createArchivalConfigHandler);
router.get('/record-errors', archivalConfigController.getRecordErrorsHandler);

export const archivalRouter = router;
