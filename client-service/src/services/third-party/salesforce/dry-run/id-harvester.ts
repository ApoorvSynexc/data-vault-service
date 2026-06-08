import { apexHarvestIds } from '../apex';

export async function harvestIds(
  crmId: string,
  objectName: string,
  whereClause: string
): Promise<string[]> {
  const whereBody = whereClause ? whereClause.replace(/^WHERE\s+/i, '').trim() : '';
  return apexHarvestIds(crmId, objectName, whereBody);
}
