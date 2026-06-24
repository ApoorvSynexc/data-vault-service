import { Router } from 'express';
import { salesofrceController } from '../../controller';
import { upsertUsersValidation, createRoleValidation, updateRoleValidation } from '../../middlewares';

const router = Router();

// Permission & User endpoints
router.get('/permissions', salesofrceController.getPermissionsHandler);
router.get('/user/list', salesofrceController.getUsersHandler);
router.post('/user-update', upsertUsersValidation, salesofrceController.upsertUsersHandler);

// Role endpoints
router.get('/role/list', salesofrceController.getRolesHandler);
router.post('/role/create', createRoleValidation, salesofrceController.createRoleHandler);
router.put('/role/update', updateRoleValidation, salesofrceController.updateRoleHandler);
router.delete('/role/delete', salesofrceController.deleteRoleHandler);

export const salesforceRouter = router;
