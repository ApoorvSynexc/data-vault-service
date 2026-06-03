import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';
import { httpRequest } from '../../../utils/http-request';
import {
  refreshSalesforceToken,
  SalesforceAuthExpiredError,
  salesforceRequest,
  SalesforceTokens,
} from '.';

const SF_API_VERSION = 'v65.0';

interface ICreateBulkQueryJob {
  instanceUrl: string;
  tokens: SalesforceTokens;
  soql: string;
  operation?: 'queryAll' | 'query';
}

// Single call returning both field names (for SOQL) and full schema (for
// schema comparison / upload). Replaces the former getObjectFields +
// getObjectSchema pair that hit the same endpoint twice per object per job.
export const getObjectMetadata = async (
  crmId: string,
  objectName: string
): Promise<{ fieldNames: string[]; schema: any[] }> => {
  const res = await httpRequest({
    url: `${CORE_SERVICE}/v1/internal/fields?crmId=${crmId}&objectName=${objectName}`,
    headers: { 'x-internal-secret': INTERNAL_SECRET },
  });
  const fields: any[] = res?.data?.fields ?? [];
  return {
    fieldNames: fields.map((f) => f.apiName),
    schema: fields,
  };
};

// ---------------------------------------------------------------------------
// Bulk API 2.0 — create
// ---------------------------------------------------------------------------
export const createBulkQueryJob = async (payload: ICreateBulkQueryJob): Promise<string> => {
  const { instanceUrl, tokens, soql, operation = 'query' } = payload;
  const res = await salesforceRequest<{ id: string }>(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query`,
      method: 'POST',
      body: JSON.stringify({ operation, query: soql }),
    },
    tokens
  );

  return res.id;
};
