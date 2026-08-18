import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { BACKUP_SERVICE, INTERNAL_SECRET, BACKUP_TYPE } from '../../constant';
import { httpRequest } from '../../utils/http-request';
import { IObject } from '../../models';

// Minimal shape for flattening the config's object tree into a flat name list.
interface INamedTreeNode {
  name: string;
  children?: INamedTreeNode[];
}

const flattenObjectNames = (objects: INamedTreeNode[]): string[] => {
  const names: string[] = [];
  for (const obj of objects) {
    names.push(obj.name);
    if (obj.children?.length) names.push(...flattenObjectNames(obj.children));
  }
  return names;
};

export interface IEnsureCompressionGlueResult {
  ensured: string[];
  failed: { objectName: string; error: string }[];
}

/**
 * After Spark reports a successful compression, ensure the current-state Hudi
 * and Delta Glue tables exist for every object in the config.
 *
 * The actual Glue mutation lives in backup-service (which owns the GlueClient and
 * the client-bucket S3 access needed to read the committed `.hoodie` schema), so
 * this only resolves the config/crm/destination and delegates over HTTP.
 *
 * Idempotent end-to-end: backup-service creates each table once and never
 * updates it, so retries and duplicate completion events are safe. Returns null
 * when the config/crm/destination can't be resolved.
 */
export const ensureCompressionGlueTables = async (
  backupConfigId: string
): Promise<IEnsureCompressionGlueResult | null> => {
  const config = await getBackupConfigById(backupConfigId);
  if (!config) return null;

  const crm = await getCrmById(config.crmId);
  if (!crm) return null;

  const destination = await getDestinationById(config.destinationId);
  if (!destination) return null;

  const destConfig = getDecryptedDestinationConfig(destination);

  const objectNames =
    config.objects && config.objects.length > 0
      ? [...new Set(flattenObjectNames((config.objects ?? []) as IObject[]))]
      : [...new Set(config.objectNames ?? [])];

  if (objectNames.length === 0) {
    return { ensured: [], failed: [] };
  }

  const response = await httpRequest<{ data: IEnsureCompressionGlueResult }>({
    url: `${BACKUP_SERVICE}/v1/glue/ensure-compression-tables`,
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({
      crmId: crm.crmId,
      crmName: crm.crmName,
      backupConfigId,
      objectNames,
      destConfig,
      // ARCHIVAL configs get the Hudi table only — no Delta.
      isArchival: config.type === BACKUP_TYPE.archival,
    }),
  });

  return response.data;
};
