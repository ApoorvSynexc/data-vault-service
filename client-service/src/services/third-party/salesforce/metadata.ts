import { getBackupConfigById, updateBackupConfig } from '../../backup-config';
import { getCrmById, getCrmTokens } from '../../crm';
import { logger } from '../../../middlewares';
import { getApexObjects, createTriggers } from './index';
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
): Promise<void> {
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

    const newObjects = extraObjects.map((obj) => ({
      name: obj.name,
      type: obj.type || 'CUSTOM',
      field: [],
    }));

    const newObjectNames = extraObjects.map((obj) => obj.name);

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

    // Fetch Salesforce objects using existing apex service
    const salesforceObjects = await getApexObjects(backupConfig.crmId);


    // Compare and find extra objects
    const extraObjects = compareObjects(
      salesforceObjects.objects,
      backupConfig.objects || []
    );

    // Add extra objects to backup config
    await addExtraObjectsToBackupConfig(backupConfigId, extraObjects);

    // Create triggers for extra objects using existing trigger service
    const extraObjectNames = extraObjects.map((obj) => obj.name);
    const { access_token, refresh_token } = getCrmTokens(crm);
    const triggerResults = await createTriggers(
      crm.crmProfile?.instanceUrl || '',
      {
        accessToken: access_token,
        refreshToken: refresh_token,
        crmId: crm.crmId,
        userId: crm.userId,
        environment: crm.environment,
        customUrl: crm.customUrl,
      },
      extraObjectNames
    );

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
