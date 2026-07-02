import { Router } from 'express';
import { storageController } from '../../controller';

const router = Router();

router.get('/overview', storageController.overview);
router.get('/last-backup-config', storageController.lastNBackupConfigHandler);

export const storageRouter = router;
