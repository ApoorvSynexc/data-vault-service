import { Router } from 'express';
import { authController } from '../../controller';
import {
  loginValidation,
  refreshTokenValidation,
  sendOtpValidation,
  verifyOtpValidation,
} from '../../middlewares';

const router = Router();

router.post('/send-otp', sendOtpValidation, authController.sendOtpHandler);
router.post('/verify-otp', verifyOtpValidation, authController.verifyOtpHandler);
router.post('/login', loginValidation, authController.loginHandler);
router.post('/refresh-token', refreshTokenValidation, authController.refreshTokenHandler);

export const authRouter = router;
