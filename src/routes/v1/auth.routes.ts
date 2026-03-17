import { Router } from 'express';
import { authController } from '../../controller';
import { sendOtpValidation } from '../../middlewares';

const router = Router();

router.post('/send-otp', sendOtpValidation, authController.sendOtpHandler);

export const authRouter = router;
