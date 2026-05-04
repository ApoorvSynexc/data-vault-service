import { Router } from 'express';
import { authController } from '../../controller';
import { socialLoginController } from '../../controller/v1/auth/social-login';
import {
  authRateLimit,
  otpRateLimit,
  loginValidation,
  resetPasswordValidation,
  sendOtpValidation,
  signupValidation,
  verifyOtpValidation,
} from '../../middlewares';

const router = Router();

router.post('/signup', authRateLimit, signupValidation, authController.signupHandler);
router.post('/send-otp', otpRateLimit, sendOtpValidation, authController.sendOtpHandler);
router.post('/verify-otp', authRateLimit, verifyOtpValidation, authController.verifyOtpHandler);
router.post('/login', authRateLimit, loginValidation, authController.loginHandler);
router.post('/refresh-token', authRateLimit, authController.refreshTokenHandler);
router.post('/logout', authController.logoutHandler);
router.post(
  '/reset-password',
  authRateLimit,
  resetPasswordValidation,
  authController.resetPasswordHandler
);

// Social login endpoints
router.get('/social-login', authRateLimit, socialLoginController.socialLoginHandler);
router.get(
  '/social-login/callback',
  authRateLimit,
  socialLoginController.socialLoginCallbackHandler
);

export const authRouter = router;
