import { logger } from '../../../../middlewares/logger';
import { IDestinationConfig, IRealtimePayload } from '../../../../models';
import { writeSchemaFile } from '../../../schema';
import { type S3KeyType } from '../../../../utils/helper';

/**
 * Persists the object descriptor that rides along with every realtime webhook hit
 * (fields, picklistValues, recordTypes, children) into the same S3 layout the
 * scheduled backup writes, so a realtime-only config is not left without schema:
 *
 *   schema/main/{object}/fields/fields.json
 *   schema/main/{object}/childs/childs.json
 *   schema/main/{object}/picklist/{field}/values.json
 *   schema/main/{object}/recordTypes/record-types.json
 *   schema/changes/{backupJobId}/…  (same four, this hit's copy)
 *
 * SCOPE — why main/ is normally skipped:
 *   The descriptor is built with the permissions of whoever's DML fired the trigger,
 *   not an integration identity. A hit from a restricted user legitimately describes
 *   fewer fields and children than one from an admin, and that is not schema drift.
 *   Overwriting main/ from a webhook would therefore let one restricted save shrink
 *   the authoritative schema — and the Glue table columns derived from it — for
 *   everyone. So main/ is written only to SEED it when nothing is stored there yet
 *   (a webhook arriving before the first scheduled backup); after that every hit
 *   writes to changes/{backupJobId}/ only, and main/ stays owned by the scheduled
 *   backup and the Schema-Sync job it triggers on drift.
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
  /** True when no schema is stored for this object yet — write main/ as well. */
  seedMain: boolean;
  type?: S3KeyType;
}

export const persistRealtimeSchema = async ({
  payload,
  destConfig,
  crmId,
  crmName,
  backupConfigId,
  backupJobId,
  seedMain,
  type = 'backup',
}: IPersistRealtimeSchemaParams): Promise<void> => {
  const { objectApiName, fields, picklistValues, recordTypes, children } = payload;
  const base = { crmId, crmName, backupConfigId, objectName: objectApiName, type, backupJobId };
  const opts = { changesOnly: !seedMain };

  // Shapes below deliberately mirror what the scheduled backup stores for each
  // kind, so readers (the Java Spark middleware, the /payload drift check in
  // client-service) never have to tell a realtime-written file from a bulk one.
  const writes: Array<[string, () => Promise<void>]> = [];

  if (fields?.length) {
    writes.push([
      'fields',
      () => writeSchemaFile(destConfig, { ...base, kind: 'fields' }, fields, opts),
    ]);
  }

  if (children?.length) {
    writes.push([
      'childs',
      () => writeSchemaFile(destConfig, { ...base, kind: 'childs' }, children, opts),
    ]);
  }

  if (recordTypes?.length) {
    writes.push([
      'recordTypes',
      () =>
        writeSchemaFile(
          destConfig,
          { ...base, kind: 'recordTypes' },
          { objectApiName, recordTypes, count: recordTypes.length },
          opts
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
          { objectApiName, fieldApiName, values, count: values?.length ?? 0 },
          opts
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
    `[realtime-schema] stored ${writes.length} artifact(s) for ${objectApiName} | scope:${seedMain ? 'main+changes' : 'changes'} backupJobId:${backupJobId}`
  );
};
