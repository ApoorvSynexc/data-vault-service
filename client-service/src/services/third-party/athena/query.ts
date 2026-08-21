import {
  AthenaClient,
  StartQueryExecutionCommand,
  StartQueryExecutionCommandInput,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AWS_REGION, AWS_ATHENA_ACCESS_KEY, AWS_ATHENA_SECRET_KEY, AWS_ATHENA_ROLE_ARN } from '../../../constant';
import { logger } from '../../../middlewares';

// Every client bucket policy grants S3 access to AWS_ATHENA_ROLE_ARN (a role
// Principal) — only a caller that has actually assumed that role via STS can
// satisfy it. Locally there's no instance profile, so a static IAM user key
// must explicitly assume it. On EC2, the instance profile IS already
// AWS_ATHENA_ROLE_ARN, so its default-chain credentials already ARE that role
// — wrapping them in another AssumeRole would be a role assuming itself,
// which fails unless the trust policy explicitly allows that (it doesn't, by
// default), for no benefit since the permissions are already there.
//
// constant/index.ts builds these with String(process.env.X), so an unset var
// reads back as the literal string "undefined" rather than undefined itself —
// excluded here so a deployed environment without these set skips straight to
// the default provider chain instead of assuming the role with garbage keys.
const isSet = (value: string): boolean => Boolean(value) && value !== 'undefined';

const staticKeys =
  isSet(AWS_ATHENA_ACCESS_KEY) && isSet(AWS_ATHENA_SECRET_KEY)
    ? { accessKeyId: AWS_ATHENA_ACCESS_KEY, secretAccessKey: AWS_ATHENA_SECRET_KEY }
    : null;

const athena = new AthenaClient({
  region: AWS_REGION,
  credentials: staticKeys
    ? fromTemporaryCredentials({
        masterCredentials: staticKeys,
        params: { RoleArn: AWS_ATHENA_ROLE_ARN, RoleSessionName: 'datavault-athena' },
      })
    : undefined,
});

// Adaptive polling: wait POLL_FIRST_MS before the first status check (Athena
// almost never finishes sooner, so an earlier check is a wasted call), then
// poll on a 250ms→2s backoff ladder.
const POLL_FIRST_MS = 2000;
const POLL_INITIAL_MS = 250;
const POLL_MAX_MS = 2000;

// Serve byte-identical repeat queries from Athena's result cache instead of
// re-scanning S3. Backup data only changes when a job/compression run lands,
// so a short reuse window is safe and turns repeat fetches into ~instant.
const RESULT_REUSE_MINUTES = 5;

// Maximum total time to wait for a query to finish before giving up (ms).
// Bulk-restore scans (delta chain over hundreds of jobs) can legitimately run
// past a minute; polling backs off to 2s so the extra headroom costs nothing
// when queries are fast.
const QUERY_TIMEOUT_MS = 300_000;

const TERMINAL_STATES = new Set<QueryExecutionState>([
  QueryExecutionState.SUCCEEDED,
  QueryExecutionState.FAILED,
  QueryExecutionState.CANCELLED,
]);

// Submits a query to Athena and returns the queryExecutionId.
const startQuery = async (sql: string, database: string, outputLocation: string): Promise<string> => {
  const input: StartQueryExecutionCommandInput = {
    QueryString: sql,
    QueryExecutionContext: { Database: database },
    ResultConfiguration: { OutputLocation: outputLocation },
    ResultReuseConfiguration: {
      ResultReuseByAgeConfiguration: { Enabled: true, MaxAgeInMinutes: RESULT_REUSE_MINUTES },
    },
  };

  let response;
  try {
    response = await athena.send(new StartQueryExecutionCommand(input));
  } catch (e) {
    // Engine v2 workgroups reject ResultReuseConfiguration — retry without it.
    if (!/ResultReuse/i.test(String((e as Error).message))) throw e;
    delete input.ResultReuseConfiguration;
    response = await athena.send(new StartQueryExecutionCommand(input));
  }

  if (!response.QueryExecutionId) {
    throw new Error('[athena] StartQueryExecution returned no QueryExecutionId');
  }

  return response.QueryExecutionId;
};

// Polls Athena until the query reaches a terminal state or the timeout is exceeded.
// Throws if the query fails, is cancelled, or times out.
const waitForQuery = async (queryExecutionId: string): Promise<void> => {
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  let interval = POLL_INITIAL_MS;

  // Initial settle wait before the first status check.
  await new Promise((resolve) => setTimeout(resolve, POLL_FIRST_MS));

  while (Date.now() < deadline) {
    const { QueryExecution } = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );

    const state = QueryExecution?.Status?.State;

    if (!state) {
      throw new Error('[athena] GetQueryExecution returned no state');
    }

    if (TERMINAL_STATES.has(state)) {
      if (state !== QueryExecutionState.SUCCEEDED) {
        const reason = QueryExecution?.Status?.StateChangeReason ?? 'unknown';
        throw new Error(`[athena] query ${state} | reason: ${reason}`);
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, POLL_MAX_MS);
  }

  throw new Error(`[athena] query timed out after ${QUERY_TIMEOUT_MS}ms`);
};

export interface IQueryResult {
  columns: string[];
  rows: Record<string, string>[];
  // Present on results that came from a real execution — the handle used to
  // re-read the same rows later without re-scanning (see fetchStoredResults).
  queryExecutionId?: string;
}

// Fetches result pages for a completed query and returns them as a flat array
// of row objects keyed by column name. Stops early once `maxRows` is reached so
// a capped read never drags the whole result set over the wire.
const fetchQueryResults = async (
  queryExecutionId: string,
  maxRows = Infinity
): Promise<IQueryResult> => {
  const columns: string[] = [];
  const rows: Record<string, string>[] = [];
  let nextToken: string | undefined;
  let isFirstPage = true;

  do {
    const { ResultSet, NextToken } = await athena.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
      })
    );

    const resultRows = ResultSet?.Rows ?? [];

    if (isFirstPage) {
      // First row of the first page is always the header row.
      const headerRow = resultRows[0];
      headerRow?.Data?.forEach((col) => columns.push(col.VarCharValue ?? ''));
      resultRows.slice(1).forEach((row) => {
        const record: Record<string, string> = {};
        row.Data?.forEach((cell, i) => { record[columns[i]] = cell.VarCharValue ?? ''; });
        rows.push(record);
      });
      isFirstPage = false;
    } else {
      resultRows.forEach((row) => {
        const record: Record<string, string> = {};
        row.Data?.forEach((cell, i) => { record[columns[i]] = cell.VarCharValue ?? ''; });
        rows.push(record);
      });
    }

    nextToken = NextToken;
  } while (nextToken && rows.length < maxRows);

  return { columns, rows: rows.slice(0, maxRows === Infinity ? rows.length : maxRows), queryExecutionId };
};

/**
 * Re-reads the results of a query that has ALREADY run, by its execution id.
 *
 * This is the cheap half of the pagination design: Athena persists every result
 * set in the workgroup's output location, so reading it back scans no data and
 * costs nothing beyond an S3 GET. It also skips the ~2s submit/poll settle, so
 * a replayed page returns in a fraction of the time a fresh query takes.
 *
 * Throws if the execution id has expired (Athena retains query metadata ~45
 * days) or its result file is gone — callers treat that as "cursor expired".
 */
export const fetchStoredResults = async (
  queryExecutionId: string,
  maxRows?: number
): Promise<IQueryResult> => {
  const result = await fetchQueryResults(queryExecutionId, maxRows);
  logger.info(
    `[athena] result replay | queryExecutionId:${queryExecutionId} rows:${result.rows.length}`
  );
  return result;
};

// Runs a SQL query against Athena, waits for completion, and returns results.
// database must be a Glue Catalog database name (e.g. the backupConfigId).
// outputLocation is the S3 prefix Athena writes results to — isolated per
// backupConfigId by the caller (see buildAthenaOutputLocation).
// `maxRows` caps how many rows are pulled back; the returned queryExecutionId
// lets a later request replay the same rows via fetchStoredResults.
export const runAthenaQuery = async (
  sql: string,
  database: string,
  outputLocation: string,
  maxRows?: number
): Promise<IQueryResult> => {
  logger.info(`[athena] executing query | database:${database} sql:${sql}`);

  const queryExecutionId = await startQuery(sql, database, outputLocation);

  logger.info(`[athena] query submitted | queryExecutionId:${queryExecutionId}`);

  await waitForQuery(queryExecutionId);

  const result = await fetchQueryResults(queryExecutionId, maxRows);

  logger.info(
    `[athena] query complete | queryExecutionId:${queryExecutionId} rows:${result.rows.length}`
  );

  return result;
};
