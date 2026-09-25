import { Router } from 'express';
import { backupJobRouter } from './backup-job.route';
import { realtimeBackupRouter } from './realtime-backup.route';
import { glueRouter } from './glue.route';
import { restoreRouter } from './restore-job.route';

const router = Router();

router.use('/backup-job', backupJobRouter);
router.use('/realtime-backup', realtimeBackupRouter);
router.use('/glue', glueRouter);
router.use('/restore', restoreRouter);

export const v1Routers = router;
