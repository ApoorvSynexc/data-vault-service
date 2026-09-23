import { Router } from 'express';
import { archivalRecordPreviewController } from '../../controller/v1/archival-record-preview';

// Mounted at '/archival-config' (routes/v1/index.ts), alongside the existing
// archivalRouter — reuses that same permission domain (role already has
// 'archival.read' etc.) instead of introducing a separate one.
const router = Router();

router.post('/salesforce/preview', archivalRecordPreviewController.searchArchivalRecordsHandler);
router.post('/salesforce/record-detail', archivalRecordPreviewController.getArchivedRecordDetailHandler);

export const archivalRecordPreviewRouter = router;
