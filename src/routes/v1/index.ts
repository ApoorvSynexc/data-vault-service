import { Router } from 'express';
import { clientRouter } from './client';

const router = Router();

// Public Route

// Private Route
router.use('/', clientRouter);

export const v1Routers = router;
