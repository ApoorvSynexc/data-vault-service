import { Router } from 'express';
import { v1Routers } from './v1';
import { internalAuth } from '../middlewares';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).send({ success: true, message: 'Service is running', data: null, meta: {} });
});
router.use('/v1', internalAuth, v1Routers);

export { router };
