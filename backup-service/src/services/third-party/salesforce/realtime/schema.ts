import { logger } from '../../../../middlewares/logger';
import { IDestinationConfig, IRealtimePayload } from '../../../../models';
import { writeSchemaFile } from '../../../schema';
import { type S3KeyType } from '../../../../utils/helper';

/**
 * Persists the object descriptor that rides along with every realtime webhook hit
 * (fields, picklistValues, recordTypes, children) into the same S3 layout the
 * scheduled backup writes, so a realtime-only config is not left without schema:
 *
 *   schema/changes/{backupJobId}/{object}/fields/fields.json
 *   schema/changes/{backupJobId}/{object}/childs/childs.json
 *   schema/changes/{backupJobId}/{object}/picklist/{field}/values.json
 *   schema/changes/{backupJobId}/{object}/recordTypes/record-types.json
 *
 * SCOPE — why main/ is never written from here:
 *   The descriptor is built with the permissions of whoever's DML fired the trigger,
 *   not an integration identity. A hit from a restricted user legitimately describes
 *   fewer fields and children than one from an admin, and that is not schema drift.
 *   Writing main/ from a webhook would therefore let one restricted save shrink the
 *   authoritative schema — and the Glue table columns derived from it — for every
 *   reader. main/ stays owned by Schema-Sync, which promotes a changes/ copy.
 *
 * Never throws: schema metadata must not fail a realtime hit whose records already
 * uploaded. Each block is independent, so one bad write does not skip the rest.
 */
interface IPersistRealtimeSchemaParams {
  payload: IRealtimePayload;
  destConfig: IDestinationConfig;
  crmId: string;
  crmName: string;
  backupConfigId: string;
  backupJobId: string;
  type?: S3KeyType;
}

export const persistRealtimeSchema = async ({
  payload,
  destConfig,
  crmId,
  crmName,
  backupConfigId,
  backupJobId,
  type = 'backup',
}: IPersistRealtimeSchemaParams): Promise<void> => {
  const { objectApiName, fields, picklistValues, recordTypes, children } = payload;
  const base = { crmId, crmName, backupConfigId, objectName: objectApiName, type, backupJobId };

  // Shapes below deliberately mirror what the scheduled backup stores for each
  // kind, so readers (the Java Spark middleware, the /payload drift check in
  // client-service) never have to tell a realtime-written file from a bulk one.
  const writes: Array<[string, () => Promise<void>]> = [];

  if (fields?.length) {
    writes.push([
      'fields',
      () => writeSchemaFile(destConfig, { ...base, kind: 'fields' }, fields),
    ]);
  }

  if (children?.length) {
    writes.push([
      'childs',
      () => writeSchemaFile(destConfig, { ...base, kind: 'childs' }, children),
    ]);
  }

  if (recordTypes?.length) {
    writes.push([
      'recordTypes',
      () =>
        writeSchemaFile(
          destConfig,
          { ...base, kind: 'recordTypes' },
          { objectApiName, recordTypes, count: recordTypes.length }
        ),
    ]);
  }

  // One file per picklist field, keyed by field api name — same granularity as
  // uploadPicklistValues, which writes one get-picklist-values reply per field.
  for (const [fieldApiName, values] of Object.entries(picklistValues ?? {})) {
    writes.push([
      `picklist:${fieldApiName}`,
      () =>
        writeSchemaFile(
          destConfig,
          { ...base, kind: 'picklist', fieldApiName },
          { objectApiName, fieldApiName, values, count: values?.length ?? 0 }
        ),
    ]);
  }

  await Promise.all(
    writes.map(async ([label, write]) => {
      try {
        await write();
      } catch (err: any) {
        logger.error(
          `[realtime-schema] failed to persist ${label} | backupConfigId:${backupConfigId} objectApiName:${objectApiName} err:${err?.message ?? err}`
        );
      }
    })
  );

  logger.info(
    `[realtime-schema] stored ${writes.length} artifact(s) for ${objectApiName} | scope:changes backupJobId:${backupJobId}`
  );
};
