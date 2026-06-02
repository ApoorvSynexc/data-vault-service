import { CORE_SERVICE, INTERNAL_SECRET } from '../../../constant';
import { updateBackupObject } from '../../backup-job';
import { httpRequest } from '../../../utils/http-request';
import {
  salesforceRequest,
  SalesforceTokens,
} from '.';

const SF_API_VERSION = 'v65.0';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

interface ICreateBulkQueryJob {
  instanceUrl: string;
  tokens: SalesforceTokens;
  soql: string;
  operation?: 'queryAll' | 'query';
}

interface IPollBulkJob {
  instanceUrl: string;
  tokens: SalesforceTokens;
  jobId: string;
  salesforceApiCount: number;
  backupJobId?: string;
  objectIndex?: number;
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
// Bulk API 2.0 — create + poll
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

export const pollBulkJob = async (payload: IPollBulkJob): Promise<number> => {
  const { instanceUrl, tokens, jobId, backupJobId, objectIndex } = payload;
  let { salesforceApiCount } = payload;
  const deadline = Date.now() + MAX_POLL_DURATION_MS;

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    if (Date.now() >= deadline) {
      throw new Error(
        `Bulk job ${jobId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`
      );
    }

    const res = await salesforceRequest<{
      state: string;
      errorMessage?: string;
      numberRecordsProcessed?: number;
    }>(
      {
        url: `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/query/${jobId}`,
      },
      tokens
    );
    salesforceApiCount++;

    if (
      backupJobId &&
      objectIndex !== undefined &&
      typeof res.numberRecordsProcessed === 'number'
    ) {
      await updateBackupObject({
        backupJobId,
        objectIndex,
        totalRecordCount: res.numberRecordsProcessed,
      });
    }

    if (res.state === 'JobComplete') {
      return res.numberRecordsProcessed ?? 0;
    }
    if (res.state === 'Failed' || res.state === 'Aborted') {
      throw new Error(`Bulk job ${jobId} ${res.state}: ${res.errorMessage ?? 'unknown'}`);
    }
  }
};
