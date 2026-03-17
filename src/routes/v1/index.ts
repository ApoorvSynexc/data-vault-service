import { Router } from 'express';
import { authRouter } from './auth.routes';

const router = Router();

router.use('/auth', authRouter);

export const v1Routers = router;
