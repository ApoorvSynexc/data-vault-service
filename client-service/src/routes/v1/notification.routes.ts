import { Router } from 'express';
import { notificationController } from '../../controller';

const router = Router();

router.get('/', notificationController.listNotificationHandler);
router.put('/status', notificationController.updateNotificationStatusHandler);
router.put('/mark-all-read', notificationController.markAllAsReadHandler);

export const notificationRouter = router;
