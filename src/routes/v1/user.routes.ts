import { Router } from 'express';
import { userController } from '../../controller';
import { loginValidation, refreshTokenValidation, signupValidation } from '../../middlewares';

const router = Router();

router.post('/signup', signupValidation, userController.signupHandler);
router.post('/login', loginValidation, userController.loginHandler);
router.post('/refresh-token', refreshTokenValidation, userController.refreshTokenHandler);

export const userRouter = router;
