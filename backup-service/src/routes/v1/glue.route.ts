import { Router } from 'express';
import { glueController } from '../../controller';

const router = Router();

router.post('/repair', glueController.repairGlueHandler);

export const glueRouter = router;
