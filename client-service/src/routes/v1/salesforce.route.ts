import { Router } from 'express';
import { salesofrceController } from '../../controller';

const router = Router();

router.post('/user-update', salesofrceController.upsertUsersHandler);

export const salesforceRouter = router;
