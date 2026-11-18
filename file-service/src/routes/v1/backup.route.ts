import { Router } from 'express';
import { backupController } from '../../controller';
import { getBackupValidation } from '../../middlewares';

const router = Router();

router.post('/', getBackupValidation, backupController.getBackupHandler);

export const backupRouter = router;
