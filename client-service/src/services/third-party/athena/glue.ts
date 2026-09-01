import { GlueClient, GetTableCommand, EntityNotFoundException } from '@aws-sdk/client-glue';
import { AWS_REGION } from '../../../constant';
import { logger } from '../../../middlewares';

// Credentials come from the SDK default chain only (task/instance role) — no
// static keys are ever passed in.
const glue = new GlueClient({ region: AWS_REGION });

// Whether a Glue table exists — checked before counting records so an object
// that simply hasn't been compressed yet (no backup job has run for it) reads
// as "0 records", not an Athena failure, while a genuine Glue/Athena error
// still throws. Mirrors backup-service's own glueTableExists
// (services/third-party/glue/index.ts) — not reusable here directly, since
// client-service never imports backup-service code.
export const tableExists = async (databaseName: string, tableName: string): Promise<boolean> => {
  try {
    await glue.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    return true;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err?.name === 'EntityNotFoundException') {
      return false;
    }
    logger.error(`[glue] tableExists failed | db:${databaseName} table:${tableName} err:${err?.name}: ${err?.message}`);
    throw err;
  }
};
