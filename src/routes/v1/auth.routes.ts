import { Router } from 'express';
import { authController } from '../../controller';
import {
  loginValidation,
  logoutValidation,
  refreshTokenValidation,
  sendOtpValidation,
  signupValidation,
  verifyOtpValidation,
} from '../../middlewares';

const router = Router();

router.post('/signup', signupValidation, authController.signupHandler);
router.post('/send-otp', sendOtpValidation, authController.sendOtpHandler);
router.post('/verify-otp', verifyOtpValidation, authController.verifyOtpHandler);
router.post('/login', loginValidation, authController.loginHandler);
router.post('/refresh-token', refreshTokenValidation, authController.refreshTokenHandler);
router.post('/logout', logoutValidation, authController.logoutHandler);

export const authRouter = router;
