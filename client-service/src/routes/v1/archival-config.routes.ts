import { Router } from 'express';
import { archivalConfigController } from '../../controller';

const router = Router();

router.get('/object-childs', archivalConfigController.getObjectChildHanlder);
router.get('/fields', archivalConfigController.getFieldsHanlder);

export const archivalRouter = router;
