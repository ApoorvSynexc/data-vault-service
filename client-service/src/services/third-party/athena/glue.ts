import { GlueClient, GetTableCommand, EntityNotFoundException } from '@aws-sdk/client-glue';
import { logger } from '../../../middlewares';

// One GlueClient per region, not one global client: Glue Data Catalog is
// regional, and a lookup must run in the same region as the client's own S3
// bucket the table's data lives in — never the platform's own default
// region, which may not match. Keyless: no static access/secret key, ever —
// resolves through the SDK's default credential provider chain (IAM role of
// the running environment).
const glueClients = new Map<string, GlueClient>();
const getGlueClient = (region: string): GlueClient => {
  let client = glueClients.get(region);
  if (!client) {
    client = new GlueClient({ region });
    glueClients.set(region, client);
  }
  return client;
};

// Whether a Glue table exists — checked before counting records so an object
// that simply hasn't been compressed yet (no backup job has run for it) reads
// as "0 records", not an Athena failure, while a genuine Glue/Athena error
// still throws. Mirrors backup-service's own glueTableExists
// (services/third-party/glue/index.ts) — not reusable here directly, since
// client-service never imports backup-service code.
export const tableExists = async (
  databaseName: string,
  tableName: string,
  region: string
): Promise<boolean> => {
  try {
    await getGlueClient(region).send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    return true;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err?.name === 'EntityNotFoundException') {
      return false;
    }
    logger.error(`[glue] tableExists failed | db:${databaseName} table:${tableName} err:${err?.name}: ${err?.message}`);
    throw err;
  }
};
