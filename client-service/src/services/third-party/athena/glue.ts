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

// Data-column names (partition keys excluded) as the Glue catalog declares them.
export const getTableColumnNames = async (
  databaseName: string,
  tableName: string,
  region: string
): Promise<string[]> => {
  const { Table } = await getGlueClient(region).send(
    new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
  );
  return (Table?.StorageDescriptor?.Columns ?? []).map((c) => c.Name ?? '').filter(Boolean);
};

// A table, once created, is never un-created — so a `true` result is cached
// forever. A `false` result is cached only briefly: the moment compression
// first runs for an object, existence flips false→true, and a fetch-records
// call landing right after that must see it, not a stale miss.
const NOT_FOUND_TTL_MS = 30_000;
const existsCache = new Map<string, { exists: boolean; checkedAt: number }>();

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
  const cacheKey = `${region}:${databaseName}:${tableName}`;
  const cached = existsCache.get(cacheKey);
  if (cached && (cached.exists || Date.now() - cached.checkedAt < NOT_FOUND_TTL_MS)) {
    return cached.exists;
  }

  try {
    await getGlueClient(region).send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    existsCache.set(cacheKey, { exists: true, checkedAt: Date.now() });
    return true;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err?.name === 'EntityNotFoundException') {
      existsCache.set(cacheKey, { exists: false, checkedAt: Date.now() });
      return false;
    }
    logger.error(`[glue] tableExists failed | db:${databaseName} table:${tableName} err:${err?.name}: ${err?.message}`);
    throw err;
  }
};
