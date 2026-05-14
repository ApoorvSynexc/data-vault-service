import { Router } from 'express';
import { authRouter } from './auth.routes';
import { userRouter } from './user.routes';
import { authenticate } from '../../middlewares';
import { crmRouter } from './crm.route';
import { backupRouter } from './backup-config.route';
import { backupJobRouter } from './backup-job.route';
import { dashboardRouter } from './dashboard.routes';
import { destinationRouter } from './destination.route';
import { internalRouter } from './internal.route';
import { publicRouter } from './public.routes';

const router = Router();

// Public routes
router.use('/auth', authRouter);
router.use('/internal', internalRouter);
router.use('/public', publicRouter);

// Private routes
router.use('/user', authenticate, userRouter);
router.use('/crm', authenticate, crmRouter);
router.use('/backup-config', authenticate, backupRouter);
router.use('/backup-job', authenticate, backupJobRouter);
router.use('/dashboard', authenticate, dashboardRouter);
router.use('/destination', authenticate, destinationRouter);

export const v1Routers = router;
