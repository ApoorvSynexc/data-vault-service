import { IUser } from "../../../../models";
import { getCrmById } from "../../../crm";
import { getDecryptedCrmCredential } from "../../../user";
import { salesforceRequest, SalesforceTokens } from "..";
import type { ISoqlCountQuery } from "./soql-generation";

const SF_API_VERSION = "v66.0";

const MAX_BATCH_SIZE = 5;

export interface ICountResult {
  id: string;
  name: string;
  count: number | null;
  success: boolean;
  error?: string;
}

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

// Resolved once per dry-run, reused across every composite batch — not
export const resolveSalesforceTokens = async (
  user: IUser
): Promise<{ instanceUrl: string; tokens: SalesforceTokens }> => {
  if (!user || !user.crmId) {
    throw new Error("CRM not connected");
  }
  const crm = await getCrmById(user.crmId);
  if (!crm) {
    throw new Error("CRM not found");
  }
  const instanceUrl = user.crmProfile?.instanceUrl;
  if (!instanceUrl) {
    throw new Error("Instance URL not found");
  }

  const { access_token, refresh_token } = getDecryptedCrmCredential(user) ?? {};
  return {
    instanceUrl,
    tokens: {
      accessToken: access_token,
      refreshToken: refresh_token,
      userId: user.userId,
      environment: crm.environment,
      customUrl: user.customUrl,
    },
  };
};

interface ICompositeSubResponse {
  referenceId: string;
  httpStatusCode: number;
  body: { totalSize?: number } | Array<{ errorCode?: string; message?: string }>;
}

// One Composite API round-trip — resolves up to MAX_BATCH_SIZE object
// COUNT() queries in a single Salesforce API call instead of one call per
// object.
const runCompositeBatch = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  batch: ISoqlCountQuery[]
): Promise<ICountResult[]> => {
  const compositeRequest = batch.map((query) => ({
    method: "GET",
    referenceId: query.referenceId,
    url: `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(query.soql)}`,
  }));

  const { data } = await salesforceRequest<{ compositeResponse: ICompositeSubResponse[] }>(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/composite`,
      method: "POST",
      // allOrNone: false — one object's bad WHERE/permission error shouldn't
      // fail the count for every other object in the same batch.
      body: JSON.stringify({ allOrNone: false, compositeRequest }),
    },
    tokens
  );

  const byReferenceId = new Map(batch.map((query) => [query.referenceId, query]));

  return (data.compositeResponse ?? []).map((response) => {
    const query = byReferenceId.get(response.referenceId)!;
    if (response.httpStatusCode >= 200 && response.httpStatusCode < 300) {
      const body = response.body as { totalSize?: number };
      return { id: query.id, name: query.name, count: body.totalSize ?? 0, success: true };
    }
    const errors = response.body as Array<{ errorCode?: string; message?: string }>;
    const error = errors?.[0]?.message ?? errors?.[0]?.errorCode ?? "Query failed";
    return { id: query.id, name: query.name, count: null, success: false, error };
  });
};

export const fetchCountsFromSalesforce = async (
  user: IUser,
  queries: ISoqlCountQuery[]
): Promise<{ results: ICountResult[]; apiCallCount: number }> => {
  if (!queries.length) {
    return { results: [], apiCallCount: 0 };
  }

  const { instanceUrl, tokens } = await resolveSalesforceTokens(user);
  const batches = chunkArray(queries, MAX_BATCH_SIZE);

  const results: ICountResult[] = [];
  for (const batch of batches) {
    results.push(...(await runCompositeBatch(instanceUrl, tokens, batch)));
  }

  return { results, apiCallCount: batches.length };
};
