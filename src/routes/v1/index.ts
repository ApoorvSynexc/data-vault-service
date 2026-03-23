import { Router } from 'express';
import { authRouter } from './auth.routes';
import { userRouter } from './user.routes';
import { authenticate } from '../../middlewares';
import { crmRouter } from './crm.route';

const router = Router();

router.use('/auth', authRouter);

router.use('/user', authenticate, userRouter);
router.use('/crm', authenticate, crmRouter);

export const v1Routers = router;
