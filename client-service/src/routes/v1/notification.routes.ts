import { Router } from 'express';
import { notificationController } from '../../controller';

const router = Router();

router.get('/list', notificationController.listNotificationHandler);
router.put('/', notificationController.updateNotificationStatusHandler);
router.put('/mark-all-read', notificationController.markAllAsReadHandler);

export const notificationRouter = router;
