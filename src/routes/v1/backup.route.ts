import { Router } from 'express';
import { backupController } from '../../controller';

const router = Router();

router.get('/objects', backupController.getObjectsHanlder);
router.get('/fields', backupController.getFieldsHanlder);

export const backupRouter = router;
