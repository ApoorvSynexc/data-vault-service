import { Router } from 'express';
import { authRouter } from './auth.routes';
import { userRouter } from './user.routes';
import { authenticate } from '../../middlewares';
import { crmRouter } from './crm.route';
import { backupRouter } from './backup-config.route';
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

export const v1Routers = router;
