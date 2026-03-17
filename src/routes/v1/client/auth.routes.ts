import { Router } from 'express';
import { authController } from '../../../controller';

const router = Router();

router.get('/', authController.authHandler);

export const authRouter = router;
