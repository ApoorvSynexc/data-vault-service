import { Router } from 'express';
import { backupRouter } from './backup.route';

const router = Router();

router.use('/backup', backupRouter);

export const v1Routers = router;
