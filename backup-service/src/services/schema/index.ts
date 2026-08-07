import { IDestinationConfig } from '../../models';
import {
  buildSchemaKey,
  buildSchemaS3Key,
  pickLegacyFieldsKey,
  type ISchemaKeyParams,
  type ISchemaS3KeyParams,
} from '../../utils/helper';
import { downloadFromS3, listS3Objects, uploadToS3 } from '../destination/s3';

/**
 * Writes one schema artifact straight from the Apex response — no read, no compare:
 *   - main/                 overwritten, so it always holds the latest version.
 *   - changes/<backupJobId>/ this job's copy of what it wrote.
 *
 * Both PUTs every time. Callers that need to know whether the schema actually moved
 * (Glue table create/update, the schemaChange flag) read the stored schema themselves
 * with readLatestSchema before calling this.
 *
 * `changesOnly` skips the main/ write. It exists for the realtime webhook, whose
 * descriptor is scoped to the permissions of whoever triggered the DML: letting a
 * restricted user's narrower view overwrite main/ would shrink the authoritative
 * schema (and with it the Glue columns) for every reader.
 */
const writeSchemaFile = async (
  destConfig: IDestinationConfig,
  params: ISchemaKeyParams,
  content: unknown,
  { changesOnly = false }: { changesOnly?: boolean } = {}
): Promise<void> => {
  const { backupJobId, ...mainParams } = params;
  const buffer = Buffer.from(JSON.stringify(content, null, 2));

  if (!changesOnly) {
    await uploadToS3(destConfig, buildSchemaKey(mainParams), buffer);
  }
  if (backupJobId) {
    await uploadToS3(destConfig, buildSchemaKey(params), buffer);
  }
};

/**
 * Latest stored field schema for an object: main/ first, falling back to the legacy
 * schema/<object>/fields/ folder (newest fields_<ts>.json, else fields.json) so configs
 * backed up before this layout keep resolving until their next job writes main/.
 * Returns null when neither layout has a schema yet.
 */
const readLatestSchema = async (
  destConfig: IDestinationConfig,
  params: ISchemaS3KeyParams
): Promise<any[] | null> => {
  const main = await downloadFromS3(destConfig, buildSchemaKey({ ...params, kind: 'fields' }));
  if (main) {
    return JSON.parse(main.toString());
  }

  const legacyBaseKey = buildSchemaS3Key(params);
  const legacyKeys = await listS3Objects(destConfig, legacyBaseKey.replace('/fields.json', '/'));
  const legacy = await downloadFromS3(destConfig, pickLegacyFieldsKey(legacyKeys, legacyBaseKey));
  return legacy ? JSON.parse(legacy.toString()) : null;
};

export { writeSchemaFile, readLatestSchema };
