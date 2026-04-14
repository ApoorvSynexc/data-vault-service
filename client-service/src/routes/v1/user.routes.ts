import { Router } from 'express';
import { userController } from '../../controller';
import { changePasswordValidation } from '../../middlewares/joi/user';

const router = Router();

router.get('/my-profile', userController.myProfileHandler);
router.get('/list', userController.usersHandler);
router.get('/logout', userController.logoutHandler);
router.post('/change-password', changePasswordValidation, userController.changePasswordHandler);
router.delete('/my-profile', userController.deleteProfileHandler);

export const userRouter = router;
