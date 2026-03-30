import { BACKUP_SERVICE } from '../../constant';
import { IBackupConfig } from '../../models';
import { httpRequest } from '../../utils/http-request';
import { getDestinationConfig, updateBackupConfig } from '../backup-config';
import { getCrmById, getCrmTokens } from '../crm';

const getSourceObjects = (config: IBackupConfig) => {
    if (config.objects?.length) {
        return config.objects.map((object) => ({
            name: object.name,
            field: object.field ?? [],
            ...(object.condition ? { condition: object.condition } : {}),
        }));
    }

    return config.objectNames.map((name) => ({
        name,
        field: [],
    }));
};

const triggerBackupJob = async (config: IBackupConfig, lastUpdatedAt?: string) => {
    const crm = await getCrmById(config.crmId);
    if (!crm) {
        throw new Error(`crm_not_found:${config.crmId}`);
    }

    const credentials = getCrmTokens(crm);
    const payload = {
        userId: config.userId,
        backupConfigId: config.backupConfigId,
        source: {
            ...credentials,
            crmId: crm.crmId,
            crmName: crm.crmName,
            instanceUrl: crm.crmProfile?.instanceUrl,
            object: getSourceObjects(config),
        },
        destination: {
            type: config.destination.type,
            config:getDestinationConfig(config)
        },
        ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    };

    console.log({
        payload
    });
    

    const result = await httpRequest({
        url: `${BACKUP_SERVICE}/v1/backup-job`,
        method: 'POST',
        body: JSON.stringify(payload),
    });

    await updateBackupConfig(config.backupConfigId, { lastBackupAt: new Date().toISOString() });
    return result;
};

export { triggerBackupJob };
