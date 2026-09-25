import { Router } from 'express';
import { realtimeBackupController } from '../../controller';

const router = Router();

router.post('/', realtimeBackupController.realtimeBackupHandler);

export const realtimeBackupRouter = router;
