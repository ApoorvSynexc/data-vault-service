import { Router } from 'express';
import { backupConfigController } from '../../controller';
import { createBackupConfigValidation, updateBackupConfigValidation } from '../../middlewares';

const router = Router();

router.get('/objects', backupConfigController.getObjectsHanlder);
router.get('/object-childs', backupConfigController.getObjectChildHandler);
router.post('/objects-count', backupConfigController.getObjectsCountHanlder);
router.get('/fields', backupConfigController.getFieldsHanlder);

router.post('/', createBackupConfigValidation, backupConfigController.createBackupConfigHandler);
router.get('/list', backupConfigController.listBackupConfigsHandler);
router.get('/', backupConfigController.getBackupConfigHandler);
router.put('/', updateBackupConfigValidation, backupConfigController.updateBackupConfigHandler);
router.delete('/', backupConfigController.deleteBackupConfigHandler);
router.get('/stats', backupConfigController.getBackupJobStatsHandler);
router.get('/initalize-payload-transform', backupConfigController.initalizePayloadTransformHandler);
router.get('/sync-metadata', backupConfigController.syncMetadataTriggerHandler);
router.get('/sync-schema-metadata', backupConfigController.syncMetadataHandler);

export const backupRouter = router;
