import { Router } from 'express';
import { backupJobController } from '../../controller';
import { createArchivalJobValidation, createBackupJobValidation } from '../../middlewares';

const router = Router();

router.post('/', createBackupJobValidation, backupJobController.createBackupJobHandler);
router.get('/resume', backupJobController.resumeBackupJobHandler);
router.post('/archival', createArchivalJobValidation, backupJobController.createArchivalJobHandler);
router.get('/archival/resume', backupJobController.resumeArchivalJobHandler);

export const backupJobRouter = router;
