import { Router } from 'express';
import { destinationController } from '../../controller';
import { createDestinationValidation, updateDestinationValidation } from '../../middlewares';

const router = Router();

router.post('/', createDestinationValidation, destinationController.createDestinationHandler);
router.get('/list', destinationController.listDestinationsHandler);
router.get('/', destinationController.getDestinationHandler);
// router.get('/config', destinationController.getDestinationConfigHandler);
router.put('/', updateDestinationValidation, destinationController.updateDestinationHandler);
router.delete('/', destinationController.deleteDestinationHandler);

export const destinationRouter = router;
