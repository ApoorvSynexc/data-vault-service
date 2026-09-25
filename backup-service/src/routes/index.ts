import { Router } from 'express';
import { v1Routers } from './v1';
import { makeResponse } from '../lib';
import { internalAuth } from '../middlewares';

const router = Router();

router.get('/health', (req, res) => makeResponse(req, res, 200, true, 'heath_check'));
router.use('/v1', internalAuth, v1Routers);

export { router };
