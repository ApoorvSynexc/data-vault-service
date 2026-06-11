import { apexHarvestIds } from '../apex';

export async function harvestIds(
  crmId: string,
  objectName: string,
  whereClause: string
): Promise<string[]> {
  const whereBody = whereClause ? whereClause.replace(/^WHERE\s+/i, '').trim() : undefined;
  const { ids } = await apexHarvestIds(crmId, objectName, { whereClause: whereBody });
  return ids;
}
