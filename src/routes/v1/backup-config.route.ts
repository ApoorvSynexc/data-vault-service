import { Router } from 'express';
import { backupConfigController } from '../../controller';

const router = Router();

router.get('/objects', backupConfigController.getObjectsHanlder);
router.get('/fields', backupConfigController.getFieldsHanlder);

export const backupRouter = router;
