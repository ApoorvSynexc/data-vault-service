import { IS3Config } from '../../models';
import {
  buildPicklistS3Key,
  buildRecordTypeS3Key,
  buildSchemaKey,
  buildSchemaS3Key,
  pickLegacyFieldsKey,
  type ISchemaKeyParams,
} from '../../utils/helper';
import { downloadFromS3, listS3Objects } from '../third-party/s3-bucket';
import { buildS3Key } from '../third-party/salesforce/metadata/common';

// Where a given artifact lived before the main/changes layout. Fields are a folder
// (fields.json plus fields_<ts>.json history) and are resolved by the caller below.
const legacyKeyFor = (params: ISchemaKeyParams): string => {
  switch (params.kind) {
    case 'picklist':
      return buildPicklistS3Key({ ...params, fieldApiName: params.fieldApiName! });
    case 'recordTypes':
      return buildRecordTypeS3Key(params);
    default:
      return buildSchemaS3Key(params);
  }
};

/**
 * Reads one schema artifact, newest source first:
 *   1. The metadata-comparison module's history file — schema/{object}/{kind}/...,
 *      last entry's .context. REALTIME+NORMAL configs only, once the job has run.
 *   2. schema/main/ — the scheduled-backup layout, written for every config type.
 *   3. The legacy schema/{object}/ paths, for configs whose last backup job
 *      predates the main/changes layout.
 * So restore and the metadata APIs keep working regardless of which of the two
 * writers (or neither yet) has covered a given config/object.
 *
 * Pass backupJobId to read what one specific scheduled-backup job wrote instead
 * (skips tier 1 and the tier-3 legacy fallback: per-job copies only exist in the
 * main/changes layout).
 *
 * Returns null when none of the three sources holds the artifact.
 */
const readSchemaFile = async (
  s3Config: IS3Config,
  params: ISchemaKeyParams
): Promise<any | null> => {
  // Latest source: the metadata-comparison module's history file (services/
  // third-party/salesforce/metadata) — a single flat key holding an array of
  // { date, backupJobId, operations, sourceType, context } entries; the most
  // recently appended entry's context is the current snapshot. Only populated
  // for REALTIME+NORMAL configs the comparison job has actually run against,
  // so this is tried first and falls through to the scheduled-backup layout
  // below for everything else (ARCHIVAL, non-REALTIME, or not run yet).
  //
  // Skipped when the caller passed backupJobId: that means "what this one
  // scheduled-backup job wrote", and this module has no per-job concept — it
  // only ever knows "latest" — so honoring it here would silently ignore the
  // caller's request for a specific job's snapshot.
  if (!params.backupJobId) {
    const latestKey = buildS3Key({
      metadataType: params.kind,
      policyConfigType: params.type,
      crmId: params.crmId,
      crmName: params.crmName,
      backupConfigId: params.backupConfigId,
      objectName: params.objectName,
      fieldApiName: params.fieldApiName,
      // Unused by buildS3Key's key formula — only present to satisfy
      // ISalesforceMetadataHandler's shape.
      backupJobId: '',
      isInitialBackup: false,
    });
    const latest = await downloadFromS3(s3Config, latestKey);
    if (latest) {
      const entries = JSON.parse(latest.toString());
      if (Array.isArray(entries) && entries.length) {
        return entries[entries.length - 1].context;
      }
    }
  }

  const main = await downloadFromS3(s3Config, buildSchemaKey(params));
  if (main) {
    return JSON.parse(main.toString());
  }
  if (params.backupJobId) {
    return null;
  }

  // if (params.kind === 'fields') {
  //   const legacyBaseKey = buildSchemaS3Key(params);
  //   const keys = await listS3Objects(s3Config, legacyBaseKey.replace('/fields.json', '/'));
  //   const legacy = await downloadFromS3(s3Config, pickLegacyFieldsKey(keys, legacyBaseKey));
  //   return legacy ? JSON.parse(legacy.toString()) : null;
  // }

  const legacy = await downloadFromS3(s3Config, legacyKeyFor(params));
  return legacy ? JSON.parse(legacy.toString()) : null;
};

export { readSchemaFile };
