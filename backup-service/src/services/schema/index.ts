import { IDestinationConfig } from '../../models';
import {
  buildSchemaKey,
  buildSchemaS3Key,
  pickLegacyFieldsKey,
  schemasAreEqual,
  type ISchemaKeyParams,
  type ISchemaS3KeyParams,
  type SchemaKind,
} from '../../utils/helper';
import { downloadFromS3, listS3Objects, uploadToS3 } from '../destination/s3';

// Same serialisation every writer used before, so a byte compare against the
// stored main/ file is a valid change check.
const serialize = (content: unknown): string => JSON.stringify(content, null, 2);

// Fields use the order-independent comparison the backup flow already relies on;
// everything else (picklists, record types, childs) is compared as stored bytes.
const isUnchanged = (
  kind: SchemaKind,
  storedRaw: string,
  body: string,
  content: unknown
): boolean => {
  if (kind !== 'fields') {
    return storedRaw === body;
  }
  try {
    return schemasAreEqual(JSON.parse(storedRaw), content as any[]);
  } catch {
    return false;
  }
};

// 'created'   — nothing was stored for this artifact before (first backup of the object)
// 'changed'   — content differs from the stored version
// 'unchanged' — main/ already held it; nothing was uploaded
type SchemaWriteResult = 'created' | 'changed' | 'unchanged';

/**
 * Writes one schema artifact into the versioned layout:
 *   - main/  is overwritten whenever the content differs, so it always holds the latest.
 *   - delta/<backupJobId>/ is written ONLY when the content changed, which is what
 *     keeps a job's delta folder a real change set instead of a full snapshot.
 *
 * Callers use the result to drive Glue: 'created' needs a new table, 'changed' an
 * updated one.
 */
const writeSchemaFile = async (
  destConfig: IDestinationConfig,
  params: ISchemaKeyParams,
  content: unknown
): Promise<SchemaWriteResult> => {
  const { backupJobId, ...mainParams } = params;
  const mainKey = buildSchemaKey(mainParams);
  const body = serialize(content);

  const stored = await downloadFromS3(destConfig, mainKey);
  if (stored && isUnchanged(params.kind, stored.toString(), body, content)) {
    return 'unchanged';
  }

  const buffer = Buffer.from(body);
  await uploadToS3(destConfig, mainKey, buffer);
  if (backupJobId) {
    await uploadToS3(destConfig, buildSchemaKey(params), buffer);
  }
  return stored ? 'changed' : 'created';
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

export { writeSchemaFile, readLatestSchema, type SchemaWriteResult };
