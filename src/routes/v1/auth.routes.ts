import { Router } from 'express';
import { authController } from '../../controller';
import { sendOtpValidation, verifyOtpValidation } from '../../middlewares';

const router = Router();

router.post('/send-otp', sendOtpValidation, authController.sendOtpHandler);
router.post('/verify-otp', verifyOtpValidation, authController.verifyOtpHandler);

export const authRouter = router;
