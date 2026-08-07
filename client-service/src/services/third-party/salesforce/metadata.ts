import { getBackupConfigById, updateBackupConfig } from '../../backup-config';
import { getCrmById } from '../../crm';
import { getUser, getDecryptedCrmCredential } from '../../user';
import { logger } from '../../../middlewares';
import { getApexObjects, createTriggers, toApexType, unwrapApex } from './index';
import { IObject } from '../../../models/backup-config';

// ─── Compare Salesforce objects with backup-config objects ────────────────────

function compareObjects(
  salesforceObjects: any[],
  backupConfigObjects: IObject[]
): any[] {
  const backupObjectNames = new Set(backupConfigObjects.map((obj) => obj.name));
  const extraObjects = salesforceObjects.filter(
    (sfObj) => !backupObjectNames.has(sfObj.apiName)
  );

  logger.info(
    `Found ${extraObjects.length} extra objects in Salesforce not in backup config`
  );
  return extraObjects;
}

// ─── Add extra objects to backup config ──────────────────────────────────────

async function addExtraObjectsToBackupConfig(
  backupConfigId: string,
  extraObjects: any[]
) {
  try {
    if (extraObjects.length === 0) {
      logger.info('No extra objects to add');
      return;
    }

    logger.info(`Adding ${extraObjects.length} extra objects to backup config`);

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
      throw new Error('Backup config not found');
    }

    const newObjects: { id: string, name: string; type: string; field: any[] }[] = [];
    const newObjectNames: string[] = [];
    extraObjects.forEach((obj) => {
      newObjects.push({
        // accessible-objects carries no id — the api name is the identity.
        id: obj.apiName,
        name: obj.apiName,
        type: obj.isCustom ? 'CUSTOM' : 'STANDARD',
        field: [],
      })
      newObjectNames.push(obj.apiName);
    });

    const updatedObjects = [
      ...(backupConfig.objects || []),
      ...newObjects,
    ];

    const updatedObjectNames = [
      ...(backupConfig.objectNames || []),
      ...newObjectNames,
    ];

    await updateBackupConfig(backupConfigId, {
      objects: updatedObjects,
      objectNames: updatedObjectNames,
    });

    logger.info('Successfully added extra objects to backup config');
  } catch (error) {
    logger.error('Error adding extra objects to backup config:', error);
    throw error;
  }
}

// ─── Sync metadata and create triggers for realtime backup ───────────────────

async function syncMetadataAndTriggers(
  backupConfigId: string
): Promise<{
  extraObjects: any[];
  triggerResults: any[];
}> {
  try {
    logger.info(`Starting metadata sync for backup config: ${backupConfigId}`);

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
      throw new Error('Backup config not found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
      throw new Error('CRM not found');
    }

    const user = await getUser({ userId: backupConfig.userId });
    if (!user) {
      throw new Error('User not found');
    }

    // Fetch Salesforce objects using existing apex service. accessible-objects
    // replies { success, data: [...] } — unwrap it, there is no `objects` key.
    const salesforceObjects = unwrapApex<any[]>(
      await getApexObjects({ user, mode: 'backup', type: toApexType(backupConfig.schedule) })
    );

    // Compare and find extra objects
    const extraObjects = compareObjects(
      salesforceObjects ?? [],
      backupConfig.objects || []
    );

    // Add extra objects to backup config
    await addExtraObjectsToBackupConfig(backupConfigId, extraObjects);

    if (backupConfig.schedule !== 'REALTIME') return { extraObjects, triggerResults: [] };

    // Create triggers for extra objects using existing trigger service
    const extraObjectNames = extraObjects.map((obj) => obj.apiName);
    const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
    const triggerCreate = await createTriggers(
      user.crmProfile?.instanceUrl || '',
      {
        accessToken: access_token,
        refreshToken: refresh_token,
        userId: user.userId,
        environment: crm.environment,
        customUrl: user.customUrl,
      },
      extraObjectNames
    );

    const triggerResults = [
      ...(backupConfig.triggerResults || []),
      ...triggerCreate,
    ];

    await updateBackupConfig(backupConfig.backupConfigId, { triggerResults });

    logger.info('Metadata sync completed');

    return {
      extraObjects,
      triggerResults,
    };
  } catch (error) {
    logger.error('Error syncing metadata:', error);
    throw error;
  }
}

export {
  syncMetadataAndTriggers,
};
