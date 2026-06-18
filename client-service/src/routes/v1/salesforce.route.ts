import { Router } from 'express';
import { salesofrceController } from '../../controller';
import { upsertUsersValidation } from '../../middlewares';

const router = Router();

router.get('/permissions', salesofrceController.getPermissionsHandler);
router.get('/user/list', salesofrceController.getUsersHandler);
router.post('/user-update', upsertUsersValidation, salesofrceController.upsertUsersHandler);

export const salesforceRouter = router;
