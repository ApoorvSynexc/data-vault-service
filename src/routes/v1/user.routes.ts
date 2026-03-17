import { Router } from 'express';
import { userController } from '../../controller';
import { signupValidation } from '../../middlewares';

const router = Router();

router.post('/signup', signupValidation, userController.signupHandler);

export const userRouter = router;
