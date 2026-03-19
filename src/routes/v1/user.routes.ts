import { Router } from 'express';
import { userController } from '../../controller';
import { authenticate } from '../../middlewares/authentication';
import { changePasswordValidation } from '../../middlewares/joi/user';

const router = Router();

router.use(authenticate);
router.get('/my-profile', userController.myProfileHandler);
router.get('/list', userController.usersHandler);
router.get('/count', userController.userCountHandler);
router.get('/logout', userController.logoutHandler);
router.post('/change-password', changePasswordValidation, userController.changePasswordHandler);

export const userRouter = router;
