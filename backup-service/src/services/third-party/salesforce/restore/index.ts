import { logger } from '../../../../middlewares/logger';
import { IDestinationConfig, IRestoreConflict, IRestoreScope, ISource } from '../../../../models';

export const runSalesforceRestore = async (
  restoreId: string,
  restoreJobId: string,
): Promise<'SUCCESS' | 'FAILED'> => {
  logger.info(`[restore] execution requested`, {
    restoreId,
    restoreJobId
  });

  throw new Error('Salesforce restore execution is not implemented yet');
};
