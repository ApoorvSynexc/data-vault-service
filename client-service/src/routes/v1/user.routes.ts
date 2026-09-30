import { Router } from 'express';
import { userController } from '../../controller';
import { updateProfileValidation } from '../../middlewares/joi/user';

const router = Router();

router.get('/my-profile', userController.myProfileHandler);
router.put('/my-profile', updateProfileValidation, userController.updateProfileHandler);
router.get('/default-permissions', userController.permissionHandler);
router.get('/logout', userController.logoutHandler);

export const userRouter = router;
