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
import { archivalRouter } from './archival-config.routes';
import { salesforceRouter } from './salesforce.route';
import { aclGateway } from '../../middlewares/gateway';

const router = Router();

// Public routes
router.use('/auth', authRouter);
router.use('/internal', internalRouter);
router.use('/public', publicRouter);
router.use('/salesforce', salesforceRouter);

// Private routes
router.use(authenticate);
router.use(aclGateway);
router.use('/user', userRouter);
router.use('/crm', crmRouter);
router.use('/backup-config', backupRouter);
router.use('/archival-config', archivalRouter);
router.use('/backup-job', backupJobRouter);
router.use('/dashboard', dashboardRouter);
router.use('/destination', destinationRouter);

export const v1Routers = router;
