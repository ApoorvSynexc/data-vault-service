import { Router } from 'express';
import { restoreController } from '../../controller';
import { createRestoreJobValidation } from '../../middlewares';

const router = Router();
router.post('/', createRestoreJobValidation, restoreController.createRestoreJobHandler);
router.post('/rollback', createRestoreJobValidation, restoreController.createRollbackJobHandler);

export const restoreRouter = router;
