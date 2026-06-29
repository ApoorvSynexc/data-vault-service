import { Router } from 'express';
import { userController } from '../../controller';
import { changePasswordValidation, updateProfileValidation } from '../../middlewares/joi/user';

const router = Router();

router.get('/my-profile', userController.myProfileHandler);
router.put('/my-profile', updateProfileValidation, userController.updateProfileHandler);
router.delete('/my-profile', userController.deleteProfileHandler);
router.get('/default-permissions', userController.permissionHandler);
router.get('/list', userController.usersHandler);
router.get('/logout', userController.logoutHandler);
router.post('/change-password', changePasswordValidation, userController.changePasswordHandler);

export const userRouter = router;
