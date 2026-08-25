import { Router } from 'express';
import { settingsController } from '../../controller';
import { upsertSettingsValidation } from '../../middlewares';

const router = Router();

router.get('/', settingsController.getSettingsHandler);
router.put('/', upsertSettingsValidation, settingsController.upsertSettingsHandler);
router.delete('/standard-object', settingsController.deleteStandardObjectHandler);

export const settingsRouter = router;
