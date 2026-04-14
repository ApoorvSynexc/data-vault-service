import { Router } from 'express';
import { backupJobController } from '../../controller';

const router = Router();

router.get('/list', backupJobController.listBackupJobsHandler);
router.get('/', backupJobController.getBackupJobHandler);
router.get('/resume', backupJobController.resumeBackupJobHandler);

export const backupJobRouter = router;
