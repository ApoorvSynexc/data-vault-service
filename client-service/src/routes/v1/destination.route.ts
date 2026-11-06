import { Router } from 'express';
import { destinationController } from '../../controller';
import {
  createDestinationValidation,
  testConnectionValidation,
  updateDestinationValidation,
} from '../../middlewares';

const router = Router();

router.get('/role-setup', destinationController.getRoleSetupHandler);
router.get('/resolve-bucket-region', destinationController.resolveBucketRegionHandler);
router.post('/test-connection', testConnectionValidation, destinationController.testConnectionHandler);
router.post('/', createDestinationValidation, destinationController.createDestinationHandler);
router.get('/list', destinationController.listDestinationsHandler);
router.get('/', destinationController.getDestinationHandler);
router.get('/config', destinationController.getDestinationConfigHandler);
router.put('/', updateDestinationValidation, destinationController.updateDestinationHandler);
router.delete('/', destinationController.deleteDestinationHandler);

export const destinationRouter = router;
