import { Router } from 'express';
import { backupJobController } from '../../controller';

const router = Router();

router.get('/list', backupJobController.listBackupJobsHandler);
router.get('/retry', backupJobController.retryBackupJobHandler);

export const backupJobRouter = router;
