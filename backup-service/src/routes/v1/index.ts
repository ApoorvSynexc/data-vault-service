import { Router } from 'express';
import { backupJobRouter } from './backup-job.route';
import { realtimeBackupRouter } from './realtime-backup.route';

const router = Router();

router.use('/backup-job', backupJobRouter);
router.use('/realtime-backup', realtimeBackupRouter);

export const v1Routers = router;
