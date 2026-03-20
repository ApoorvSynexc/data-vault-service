import { Router } from 'express';
import { integratioController } from '../../controller';

const router = Router();

router.get('/login', integratioController.integrationLoginHanlder);
router.get('/callback', integratioController.integrationCodeHanlder);

export const integrationRouter = router;
