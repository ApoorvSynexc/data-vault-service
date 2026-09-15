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

// A table, once created, is never un-created — so a `true` result is cached
// forever. A `false` result is cached only briefly: the moment compression
// first runs for an object, existence flips false→true, and a fetch-records
// call landing right after that must see it, not a stale miss.
const NOT_FOUND_TTL_MS = 30_000;
interface ITableCacheEntry {
  exists: boolean;
  checkedAt: number;
  // Column API names from the table's StorageDescriptor — null when exists is
  // false (nothing to describe).
  columns: string[] | null;
}
const existsCache = new Map<string, ITableCacheEntry>();

// Shared lookup behind tableExists/getTableColumns — one Glue GetTable call,
// one cache entry, so a caller that needs both never pays for it twice.
const fetchTable = async (
  databaseName: string,
  tableName: string,
  region: string
): Promise<ITableCacheEntry> => {
  const cacheKey = `${region}:${databaseName}:${tableName}`;
  const cached = existsCache.get(cacheKey);
  if (cached && (cached.exists || Date.now() - cached.checkedAt < NOT_FOUND_TTL_MS)) {
    return cached;
  }

  try {
    const result = await getGlueClient(region).send(
      new GetTableCommand({ DatabaseName: databaseName, Name: tableName })
    );
    const columns =
      result.Table?.StorageDescriptor?.Columns?.map((c) => c.Name).filter(
        (name): name is string => Boolean(name)
      ) ?? null;
    const entry: ITableCacheEntry = { exists: true, checkedAt: Date.now(), columns };
    existsCache.set(cacheKey, entry);
    return entry;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err?.name === 'EntityNotFoundException') {
      const entry: ITableCacheEntry = { exists: false, checkedAt: Date.now(), columns: null };
      existsCache.set(cacheKey, entry);
      return entry;
    }
    logger.error(`[glue] tableExists failed | db:${databaseName} table:${tableName} err:${err?.name}: ${err?.message}`);
    throw err;
  }
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
): Promise<boolean> => (await fetchTable(databaseName, tableName, region)).exists;

// The table's actual column API names, straight off its Glue StorageDescriptor
// — null when the table doesn't exist. Lets a caller tell "this object's
// compressed table never captured this field" apart from "the value is blank
// on this row", before a SELECT of a nonexistent column fails the query.
export const getTableColumns = async (
  databaseName: string,
  tableName: string,
  region: string
): Promise<string[] | null> => (await fetchTable(databaseName, tableName, region)).columns;
