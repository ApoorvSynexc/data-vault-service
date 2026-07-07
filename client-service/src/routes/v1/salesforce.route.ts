import { Router } from 'express';
import { salesofrceController } from '../../controller';
import { upsertUsersValidation, createRoleValidation, updateRoleValidation, attachDecryptedSalesforceRequest } from '../../middlewares';

const router = Router();

// Permission & User endpoints
router.get('/permissions', salesofrceController.getPermissionsHandler);
router.put('/permissions', attachDecryptedSalesforceRequest('body'), salesofrceController.updatePermissionsHandler);
router.get('/user/list', attachDecryptedSalesforceRequest('query'), salesofrceController.getUsersHandler);
router.post('/user-update', attachDecryptedSalesforceRequest('body'), upsertUsersValidation, salesofrceController.upsertUsersHandler);

// Role endpoints
router.get('/role/list', attachDecryptedSalesforceRequest('query'), salesofrceController.getRolesHandler);
router.post('/role/create', attachDecryptedSalesforceRequest('body'), createRoleValidation, salesofrceController.createRoleHandler);
router.put('/role/update', attachDecryptedSalesforceRequest('body'), updateRoleValidation, salesofrceController.updateRoleHandler);
router.delete('/role/delete', attachDecryptedSalesforceRequest('query'), salesofrceController.deleteRoleHandler);

export const salesforceRouter = router;
