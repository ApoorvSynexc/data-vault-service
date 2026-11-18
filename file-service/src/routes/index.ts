import { Router } from 'express';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).send({ success: true, message: 'Service is running', data: null, meta: {} });
});

export { router };
