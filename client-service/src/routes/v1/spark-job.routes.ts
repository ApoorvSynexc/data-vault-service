import { Router } from 'express';
import { sparkJobController } from '../../controller';

const router = Router();

router.post('/build-payload', sparkJobController.buildPayloadHandler);

export const sparkRouter = router;
