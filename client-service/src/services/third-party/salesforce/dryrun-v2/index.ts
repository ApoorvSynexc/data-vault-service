import { logger } from "../../../../middlewares";
import type { IUser } from "../../../../models";
import type { ISalesforceObject } from "../dry-run/types";
import { generateSoqlQueries } from "./soql-generation";
import { fetchCountsFromSalesforce, ICountResult } from "./salesforce-api";

export type { ISalesforceObject } from "../dry-run/types";

export interface IDryRunV2Payload {
  user: IUser;
  objects: ISalesforceObject[];
}

export interface IDryRunV2ObjectResult {
  id: string;
  name: string;
  count: number | null;
  success: boolean;
  error?: string;
  children?: IDryRunV2ObjectResult[];
}

export interface IDryRunV2Result {
  objects: IDryRunV2ObjectResult[];
  // Number of Composite API round-trips made — not one per object like v1's
  // apiCallCount, since every object's COUNT() query is batched into as few
  // Composite API calls as possible.
  apiCallCount: number;
}

// Rebuilds the original object tree shape, attaching each node's count from
// the flat results Salesforce returned.
const attachCounts = (
  objects: ISalesforceObject[],
  countsById: Map<string, ICountResult>
): IDryRunV2ObjectResult[] =>
  objects.map((object) => {
    const outcome = countsById.get(object.id);
    return {
      id: object.id,
      name: object.name,
      count: outcome?.count ?? null,
      success: outcome?.success ?? false,
      ...(outcome?.error && { error: outcome.error }),
      ...(object.children?.length && { children: attachCounts(object.children, countsById) }),
    };
  });

// Entry point — calls soql-generation to turn the object tree into COUNT()
// queries, then salesforce-api to resolve them via the Composite API, and
// reassembles the result back into the original tree shape.
export const dryRunV2 = async (payload: IDryRunV2Payload): Promise<IDryRunV2Result> => {
  const { user, objects } = payload;

  const queries = generateSoqlQueries(objects);
  logger.info(`[dry-run-v2] generated ${queries.length} SOQL count quer${queries.length === 1 ? 'y' : 'ies'}`);

  const { results, apiCallCount } = await fetchCountsFromSalesforce(user, queries);
  const countsById = new Map(results.map((result) => [result.id, result]));

  return { objects: attachCounts(objects, countsById), apiCallCount };
};
