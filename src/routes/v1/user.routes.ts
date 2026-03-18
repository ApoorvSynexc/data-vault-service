import { Router } from 'express';
import { userController } from '../../controller';
import { authenticate } from '../../middlewares/authentication';

const router = Router();

router.use(authenticate);
router.get('/my-profile', userController.myProfileHandler);

export const userRouter = router;
