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
 * Reads one schema artifact written by backup-service. Always resolves the latest
 * version — schema/main/ — and falls back to the legacy schema/{object}/ paths for
 * configs whose last backup job predates the main/changes layout, so restore and the
 * metadata APIs keep working until those configs run again.
 *
 * Pass backupJobId to read what one specific job wrote instead (no legacy fallback
 * there: per-job copies only exist in the new layout).
 *
 * Returns null when neither layout holds the artifact.
 */
const readSchemaFile = async (
  s3Config: IS3Config,
  params: ISchemaKeyParams
): Promise<any | null> => {
  const main = await downloadFromS3(s3Config, buildSchemaKey(params));
  if (main) {
    return JSON.parse(main.toString());
  }
  if (params.backupJobId) {
    return null;
  }

  if (params.kind === 'fields') {
    const legacyBaseKey = buildSchemaS3Key(params);
    const keys = await listS3Objects(s3Config, legacyBaseKey.replace('/fields.json', '/'));
    const legacy = await downloadFromS3(s3Config, pickLegacyFieldsKey(keys, legacyBaseKey));
    return legacy ? JSON.parse(legacy.toString()) : null;
  }

  const legacy = await downloadFromS3(s3Config, legacyKeyFor(params));
  return legacy ? JSON.parse(legacy.toString()) : null;
};

export { readSchemaFile };
