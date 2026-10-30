import { Router } from 'express';
import { restoreController } from '../../controller';
import { createRestoreJobValidation } from '../../middlewares';

const router = Router();
router.post('/', createRestoreJobValidation, restoreController.createRestoreJobHandler);
router.post('/rollback', createRestoreJobValidation, restoreController.createRollbackJobHandler);
router.post('/resume', restoreController.resumeRestoreJobHandler);

export const restoreRouter = router;
