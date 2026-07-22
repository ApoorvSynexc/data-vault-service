import { logger } from '../../../../middlewares/logger';
import { IDestinationConfig, IRestoreConflict, IRestoreScope, ISource } from '../../../../models';

export const runSalesforceRestore = async (
  restoreId: string,
  restoreJobId: string,
  source: ISource,
  destinationType: string,
  destConfig: IDestinationConfig,
  restoreScope: IRestoreScope,
  conflict: IRestoreConflict
): Promise<'SUCCESS' | 'FAILED'> => {
  logger.info(`[restore] execution requested`, {
    restoreId,
    restoreJobId,
    scopeType: restoreScope.type,
    restoreMode: conflict.restoreMode,
    destinationType,
  });

  throw new Error('Salesforce restore execution is not implemented yet');
};
