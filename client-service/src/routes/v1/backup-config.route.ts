import { Router } from 'express';
import { backupConfigController } from '../../controller';
import { createBackupConfigValidation, updateBackupConfigValidation, recoverTriggerValidation } from '../../middlewares';

const router = Router();


router.post('/', createBackupConfigValidation, backupConfigController.createBackupConfigHandler);
router.get('/list', backupConfigController.listBackupConfigsHandler);
router.get('/', backupConfigController.getBackupConfigHandler);
router.put('/', updateBackupConfigValidation, backupConfigController.updateBackupConfigHandler);
router.delete('/', backupConfigController.deleteBackupConfigHandler);
router.get('/run-now', backupConfigController.runNowHandler);
router.get('/stats', backupConfigController.getBackupJobStatsHandler);
router.get('/initalize-payload-transform', backupConfigController.initalizePayloadTransformHandler);
router.get('/sync-metadata', backupConfigController.syncMetadataTriggerHandler);
router.get('/sync-schema-metadata', backupConfigController.syncMetadataHandler);
router.post('/trigger/recover', recoverTriggerValidation, backupConfigController.recoverTriggerHandler);

export const backupRouter = router;
