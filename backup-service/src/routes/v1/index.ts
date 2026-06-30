import { Router } from 'express';
import { backupJobRouter } from './backup-job.route';
import { realtimeBackupRouter } from './realtime-backup.route';
import { glueRouter } from './glue.route';

const router = Router();

router.use('/backup-job', backupJobRouter);
router.use('/realtime-backup', realtimeBackupRouter);
router.use('/glue', glueRouter);

export const v1Routers = router;
