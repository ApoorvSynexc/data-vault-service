import { Router } from 'express';
import { authRouter } from './auth.routes';

const router = Router();

// Private Route
router.use('/auth', authRouter);

// Public Route

export const clientRouter = router;
