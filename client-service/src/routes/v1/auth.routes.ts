import { Router } from 'express';
import { authController } from '../../controller';
import { socialLoginController } from '../../controller/v1/auth/social-login';
import { authorizeController } from '../../controller/v1/auth/authorize';

import {
  authRateLimit,
  loginValidation,
  signupValidation,
  authorizeOrganizationValidation,
} from '../../middlewares';

const router = Router();

router.post('/signup', authRateLimit, signupValidation, authController.signupHandler);
router.post('/login', authRateLimit, loginValidation, authController.loginHandler);
router.post('/refresh-token', authController.refreshTokenHandler);
router.post('/logout', authController.logoutHandler);

// Social login endpoints
router.get('/social-login', socialLoginController.socialLoginHandler);
router.get(
  '/social-login/callback',
  socialLoginController.socialLoginCallbackHandler
);
router.post('/configure-org', authorizeOrganizationValidation, authorizeController.authorizationHandler);

export const authRouter = router;
