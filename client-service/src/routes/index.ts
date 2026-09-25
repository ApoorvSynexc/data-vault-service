import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { v1Routers } from './v1';
import { makeResponse } from '../lib';
import { swaggerSpec, swaggerUiOptions } from '../config/swagger';

const router = Router();

router.get('/health', (req, res) => makeResponse(req, res, 200, true, 'heath_check'));

router.get('/docs.json', (req, res) => res.json(swaggerSpec));
router.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

router.use('/v1', v1Routers);

export { router };
