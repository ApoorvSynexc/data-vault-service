import dayjs from 'dayjs';
import { IBackupConfig, IS3Config } from '../../models';
import { logger } from '../../middlewares';
import { getUser } from '../user';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { triggerBackupJob } from '../backup-job';
import {
  getApexFields,
  getApexPicklistValues,
  getRecordTypeMetadata,
  unwrapApex,
} from '../third-party/salesforce/apex';
import { readSchemaFile } from '../schema';
import { schemasAreEqual } from '../../utils/helper';

// ponytail: raw JSON compare — both sides come from the same Apex source (current
// call vs the file a prior backup wrote from that same call), so key order is
// stable. Swap for a normalized deep-equal if a shape ever reorders keys.
const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// True if the object's schema, any picklist values, or record-type metadata differ
// from what's stored in S3. A missing stored file counts as drift (first-time seed).
// Ordered cheap-first (schema, record-type, then per-field picklists) and short-circuits.
const objectHasDrift = async (
  user: any,
  s3cfg: IS3Config,
  crmId: string,
  crmName: string,
  backupConfigId: string,
  objectName: string
): Promise<boolean> => {
  // ── Schema ──────────────────────────────────────────────────────────────────
  const fieldsReply = unwrapApex<{ fields?: any[] }>(
    await getApexFields({ user, objectName, mode: 'backup' })
  );
  const currentFields: any[] = fieldsReply?.fields ?? (Array.isArray(fieldsReply) ? fieldsReply : []);

  // Empty field list means the metadata call gave us nothing usable — don't false-
  // trigger a backup off a transient/empty read; treat as no detectable drift.
  if (!currentFields.length) {
    return false;
  }

  // Stored metadata comes from schema/main/ (the latest version a scheduled backup
  // wrote), with readSchemaFile falling back to the legacy layout.
  const keyParams = { crmId, crmName, backupConfigId, objectName, type: 'backup' as const };

  const storedSchema = await readSchemaFile(s3cfg, { ...keyParams, kind: 'fields' });
  if (!storedSchema || !schemasAreEqual(storedSchema, currentFields)) {
    return true;
  }

  // ── Record types ──────────────────────────────────────────────────────────────
  const currentRecordTypes = unwrapApex(await getRecordTypeMetadata({ user, objectApiName: objectName }));
  const storedRt = await readSchemaFile(s3cfg, { ...keyParams, kind: 'recordTypes' });
  if (!storedRt || !jsonEqual(storedRt, currentRecordTypes)) {
    return true;
  }

  // ── Picklists (one file per picklist field) ───────────────────────────────────
  // PICKLIST and MULTIPICKLIST are distinct Apex DisplayTypes; both carry values.
  const picklistFields = currentFields.filter((f) =>
    ['picklist', 'multipicklist'].includes(String(f.dataType ?? '').toLowerCase())
  );
  for (const field of picklistFields) {
    const currentValues = unwrapApex(
      await getApexPicklistValues({ user, objectApiName: objectName, fieldApiName: field.apiName })
    );
    const storedValues = await readSchemaFile(s3cfg, {
      ...keyParams,
      kind: 'picklist',
      fieldApiName: field.apiName,
    });
    if (!storedValues || !jsonEqual(storedValues, currentValues)) {
      return true;
    }
  }

  return false;
};

// SOQL datetime literal for "yesterday 23:00" (local). exportIncremental queries
// LastModifiedDate >= this, so the Schema-Sync job captures everything changed since
// last night's 11 PM.
const yesterdayElevenPm = (): string =>
  dayjs().subtract(1, 'day').hour(23).minute(0).second(0).millisecond(0).toISOString();

/**
 * For a REALTIME backup config, detect schema/picklist/record-type drift before the
 * /payload compression runs. On any drift, kick off a Schema-Sync backup job
 * (incremental since yesterday 23:00, reusing the initial-backup flow) and return true
 * so the caller defers compression — it resumes when the job calls back with
 * 'schema.sync.completed'. Returns false when nothing drifted (compress now).
 *
 * ponytail: O(objects × picklist-fields) Salesforce calls per trigger, short-circuited
 * on first drift. Fine for typical configs; if it gets hot, move drift detection into
 * the realtime webhook path or cache per-object metadata hashes.
 */
export const runRealtimeSchemaSync = async (config: IBackupConfig): Promise<boolean> => {
  const [user, crm, destination] = await Promise.all([
    getUser({ userId: config.userId }),
    getCrmById(config.crmId),
    getDestinationById(config.destinationId),
  ]);

  if (!user || !crm || !destination) {
    logger.warn(`[schema-sync] missing user/crm/destination for config ${config.backupConfigId} — skipping drift check`);
    return false;
  }

  const s3cfg = getDecryptedDestinationConfig(destination) as IS3Config;
  const objects = config.objects ?? [];

  let drift = false;
  for (const obj of objects) {
    try {
      if (await objectHasDrift(user, s3cfg, config.crmId, crm.crmName, config.backupConfigId, obj.name)) {
        drift = true;
        break;
      }
    } catch (err: any) {
      // A metadata read failure must not spuriously spawn a backup — log and move on.
      logger.error(`[schema-sync] drift check failed for ${obj.name} | config:${config.backupConfigId} err:${err?.message ?? err}`);
    }
  }

  if (!drift) {
    return false;
  }

  logger.info(`[schema-sync] metadata drift detected for config ${config.backupConfigId} — triggering Schema-Sync backup`);
  await triggerBackupJob({ user, config, lastUpdatedAt: yesterdayElevenPm(), schemaSync: true });
  return true;
};
