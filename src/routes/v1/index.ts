import { Router } from 'express';
import { authRouter } from './auth.routes';
import { userRouter } from './user.routes';
import { authenticate } from '../../middlewares';
import { integrationRouter } from './integration.route';

const router = Router();

router.use('/auth', authRouter);

router.use('/user', authenticate, userRouter);
router.use('/integration', authenticate, integrationRouter);

export const v1Routers = router;
