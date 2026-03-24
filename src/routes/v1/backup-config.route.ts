import { Router } from 'express';
import { backupConfigController } from '../../controller';
import { createBackupConfigValidation, updateBackupConfigValidation } from '../../middlewares';

const router = Router();

router.get('/objects', backupConfigController.getObjectsHanlder);
router.get('/fields', backupConfigController.getFieldsHanlder);

router.post('/', createBackupConfigValidation, backupConfigController.createBackupConfigHandler);
router.get('/', backupConfigController.listBackupConfigsHandler);
router.get('/detail', backupConfigController.getBackupConfigHandler);
router.put('/', updateBackupConfigValidation, backupConfigController.updateBackupConfigHandler);
router.delete('/', backupConfigController.deleteBackupConfigHandler);

export const backupRouter = router;
