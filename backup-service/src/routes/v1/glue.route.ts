import { Router } from 'express';
import { glueController } from '../../controller';

const router = Router();

router.post('/ensure-compression-tables', glueController.ensureCompressionTablesHandler);

export const glueRouter = router;
