import { Router } from 'express';
import { backupJobController } from '../../controller';
import { createBackupJobValidation } from '../../middlewares';

const router = Router();

router.post('/', createBackupJobValidation, backupJobController.createBackupJobHandler);
router.get('/resume', backupJobController.resumeBackupJobHandler);
router.post('/archival', createBackupJobValidation, backupJobController.createArchivalJobHandler);
router.get('/archival/resume', backupJobController.resumeArchivalJobHandler);

export const backupJobRouter = router;
