import { Router } from 'express';
import { restoreRetrieveJobController } from '../../controller';
import { createRestoreValidation, uploadSingleCsv, bulkCsvUploadRateLimit } from '../../middlewares';

/**
 * Restore & Retrieve routes — all require authentication (applied at the parent router level).
 *
 * GET  /get-objectlist-by-configid      — object list selected on a single backup config
 * POST /retrieve/fetch-records          — records for one object out of the compressed Hudi/Delta
 *                                         tables: ENTIRE, or CHANGED_BETWEEN a date window, each row
 *                                         tagged with the OPERATION a restore would perform
 * POST /retrieve/fetch-missing-fields   — fields the backup config's stored S3 schema has that the
 *                                         destination object's live Salesforce fields do not
 * POST /retrieve/fetch-missing-record-types — record types, grouped by object, that the backup's
 *                                         history flagged inactive/deleted and are still missing or
 *                                         inactive on the destination org right now
 * POST /retrieve/required-fields        — one object's required fields after restore field
 *                                         filtering (restore-writable, non-system, required-on-create)
 * GET  /fetch-object-fields             — latest S3 schema for objectApiName across the (single)
 *                                         backup config shared by the given backupJobIds
 * POST /dry-run                         — record counts a restore configuration would touch
 *                                         (ENTIRE: main Hudi only; CHANGED_BETWEEN: delta
 *                                         total/UPDATE/DELETE) — read-only, no restore is performed
 * POST /dry-run-diff                    — the same configuration, but returning the records
 *                                         themselves instead of counts, each paired with the
 *                                         destination org's current version of that record
 *                                         ({changeRecord, salesforceRecord}). Capped per object;
 *                                         read-only, no restore is performed
 * POST /retrieve/validate-query         — validates one object's SOQL FILTER condition by
 *                                         converting it to an Athena WHERE clause and running it
 *                                         (LIMIT 1) against that object's compressed Hudi table —
 *                                         { matched: boolean, valid: true } — valid confirms the
 *                                         query itself ran successfully, independent of whether
 *                                         matched is true or false
 * GET  /download-csv                    — for a completed restore job, returns presigned S3 URLs
 *                                         (one per part) so the client downloads the exported
 *                                         CSV(s) for one object directly from S3
 * POST /bulk-csv/parse                  — uploads a CSV of record Ids (multipart, field "file",
 *                                         plus "objectName" and "backupConfigId" fields), uploads it
 *                                         to that config's destination S3, and returns
 *                                         { objectName, ids, s3Key } for use as one entry of
 *                                         restoreScope.bulkCsvIds when creating a restore
 */
const router = Router();

router.post('/', createRestoreValidation, restoreRetrieveJobController.createRestoreHandler2);
router.post(
  '/bulk-csv/upload',
  bulkCsvUploadRateLimit,
  uploadSingleCsv('file'),
  restoreRetrieveJobController.parseBulkCsvIdsHandler
);
router.get('/config/list', restoreRetrieveJobController.listRestoresHandler);
router.get('/job', restoreRetrieveJobController.getRestoreJobHandler);
router.put('/job/rollback', restoreRetrieveJobController.createRollbackHandler);
router.get('/job/stats', restoreRetrieveJobController.getRestoreJobStatsHandler);
router.get('/get-objectlist-by-configid', restoreRetrieveJobController.getObjectListByConfigIdHandler);
router.post('/retrieve/fetch-records', restoreRetrieveJobController.fetchRecordsHandler);
router.post('/retrieve/fetch-missing-fields', restoreRetrieveJobController.fetchMissingFieldsHandler);
router.post('/retrieve/fetch-missing-record-types', restoreRetrieveJobController.fetchMissingRecordTypesHandler);
router.post('/retrieve/required-fields', restoreRetrieveJobController.requiredFieldsHandler);
router.post('/retrieve/validate-query', restoreRetrieveJobController.validateQueryHandler);
router.get('/fetch-object-fields', restoreRetrieveJobController.fetchObjectFieldsHandler);
router.post('/dry-run', restoreRetrieveJobController.dryRunHandler);
router.post('/dry-run-diff', restoreRetrieveJobController.dryRunDiffHandler);
router.get('/get-picklist-field-values', restoreRetrieveJobController.getPicklistFieldValuesHandler);
router.get('/download-csv', restoreRetrieveJobController.downloadCsvFile);

export const restoreRetrieveRouter = router;
