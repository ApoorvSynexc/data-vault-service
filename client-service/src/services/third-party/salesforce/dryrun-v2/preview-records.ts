import { IUser } from "../../../../models";
import { salesforceRequest } from "..";
import { resolveSalesforceTokens } from "./salesforce-api";

const SF_API_VERSION = "v66.0";

const COUNT_PROJECTION_RE = /^SELECT\s+COUNT\(\)\s*/i;

export interface IPreviewRecordsParams {
  user: IUser;
  objectName: string;
  fieldNames: string[];
  soql: string;
  limit?: number;
}

export interface IPreviewRecordsResult {
  records: Record<string, any>[];
  totalSize: number;
  done: boolean;
}

// Fetches actual matching records (not just a count) for one object — used
// to preview a sample of what an archival/dry-run filter would actually
// match. Reformats the COUNT() query soql-generation already built for that
// object by swapping its `SELECT COUNT()` projection for the requested
// fields — the FROM/WHERE stays exactly as generateSoqlQueries built it, so
// the preview matches the same rows the count reflects.
export const previewRecords = async (params: IPreviewRecordsParams): Promise<IPreviewRecordsResult> => {
  const { user, objectName, fieldNames, soql, limit } = params;

  if (!fieldNames.length) {
    throw new Error("fieldNames must include at least one field");
  }
  if (!COUNT_PROJECTION_RE.test(soql)) {
    throw new Error(`Expected a COUNT() query from generateSoqlQueries, got: "${soql}"`);
  }
  if (!new RegExp(`\\bFROM\\s+${objectName}\\b`, 'i').test(soql)) {
    throw new Error(`soql doesn't query ${objectName}: "${soql}"`);
  }

  const { instanceUrl, tokens } = await resolveSalesforceTokens(user);

  const query = soql.replace(COUNT_PROJECTION_RE, `SELECT ${fieldNames.join(', ')} `) + (limit ? ` LIMIT ${limit}` : '');

  const { data } = await salesforceRequest<{ totalSize: number; done: boolean; records: Record<string, any>[] }>(
    {
      url: `${instanceUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(query)}`,
      method: "GET",
    },
    tokens
  );

  return {
    records: data.records ?? [],
    totalSize: data.totalSize ?? 0,
    done: data.done ?? true,
  };
};
