import { Router } from 'express';
import { userController } from '../../controller';
import { loginValidation, signupValidation } from '../../middlewares';

const router = Router();

router.post('/signup', signupValidation, userController.signupHandler);
router.post('/login', loginValidation, userController.loginHandler);

export const userRouter = router;
