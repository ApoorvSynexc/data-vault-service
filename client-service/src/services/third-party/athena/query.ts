import {
  AthenaClient,
  StartQueryExecutionCommand,
  StartQueryExecutionCommandInput,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AWS_REGION, AWS_ATHENA_ACCESS_KEY, AWS_ATHENA_SECRET_KEY, AWS_ATHENA_ROLE_ARN, AWS_ATHENA_DEBUG } from '../../../constant';
import { logger } from '../../../middlewares';

// AWS SDK clients accept a `logger` with this shape and call it internally
// around every request/response — this is the SDK-level equivalent of the
// CLI's --debug flag. Routed through `logger.info` (not `.debug`) so it
// actually prints regardless of winston's configured level, since the point
// of AWS_ATHENA_DEBUG is "make it show up".
const athenaSdkLogger = {
  debug: (...args: unknown[]) => logger.info('[athena-sdk]', ...args),
  info: (...args: unknown[]) => logger.info('[athena-sdk]', ...args),
  warn: (...args: unknown[]) => logger.warn('[athena-sdk]', ...args),
  error: (...args: unknown[]) => logger.error('[athena-sdk]', ...args),
};

// Every client bucket policy grants S3 access to AWS_ATHENA_ROLE_ARN (a role
// Principal) — only a caller that has actually assumed that role via STS can
// satisfy it. The EC2 instance role is a SEPARATE identity from this role
// (confirmed manually: `aws sts assume-role` from the instance succeeds), so
// this must always assume it — there is no environment where skipping the
// assume step is correct.
//
// masterCredentials is the base identity used to do the assuming: explicit
// static keys when configured (local/dev), otherwise omitted so
// fromTemporaryCredentials falls back to ITS OWN default provider chain (the
// EC2 instance role in a deployed environment) as the base.
//
// constant/index.ts builds these with String(process.env.X), so an unset var
// reads back as the literal string "undefined" rather than undefined itself —
// excluded here so a deployed environment without these set assumes from the
// default chain instead of assuming with garbage keys.
const isSet = (value: string): boolean => Boolean(value) && value !== 'undefined';

const masterCredentials =
  isSet(AWS_ATHENA_ACCESS_KEY) && isSet(AWS_ATHENA_SECRET_KEY)
    ? { accessKeyId: AWS_ATHENA_ACCESS_KEY, secretAccessKey: AWS_ATHENA_SECRET_KEY }
    : undefined;

const athena = new AthenaClient({
  region: AWS_REGION,
  // credentials: fromTemporaryCredentials({
  //   masterCredentials,
  //   params: { RoleArn: AWS_ATHENA_ROLE_ARN, RoleSessionName: 'datavault-athena' },
  // }),
  ...(AWS_ATHENA_DEBUG ? { logger: athenaSdkLogger } : {}),
});

// Adaptive polling: wait POLL_FIRST_MS before the first status check (Athena
// almost never finishes sooner, so an earlier check is a wasted call), then
// poll on a 250ms→2s backoff ladder.
const POLL_FIRST_MS = 2000;
const POLL_INITIAL_MS = 250;
const POLL_MAX_MS = 2000;

// Maximum total time to wait for a query to finish before giving up (ms).
// Bulk-restore scans (delta chain over hundreds of jobs) can legitimately run
// past a minute; polling backs off to 2s so the extra headroom costs nothing
// when queries are fast.
const QUERY_TIMEOUT_MS = 300_000;

// Never logs secret keys — only whether static master credentials are
// configured, so a misconfigured env var shows up without leaking anything.
// Deferred via setImmediate: `logger` comes through the middlewares barrel,
// which has a circular import back to this module — logging synchronously at
// the top level can run before that cycle resolves and crash on `undefined`.
setImmediate(() => {
  logger.info(
    `[athena] settings | region:${AWS_REGION} roleArn:${AWS_ATHENA_ROLE_ARN} sessionName:datavault-athena ` +
    `usingStaticMasterCredentials:${Boolean(masterCredentials)} debug:${AWS_ATHENA_DEBUG} ` +
    `pollFirstMs:${POLL_FIRST_MS} pollInitialMs:${POLL_INITIAL_MS} pollMaxMs:${POLL_MAX_MS} queryTimeoutMs:${QUERY_TIMEOUT_MS}`
  );
});

const TERMINAL_STATES = new Set<QueryExecutionState>([
  QueryExecutionState.SUCCEEDED,
  QueryExecutionState.FAILED,
  QueryExecutionState.CANCELLED,
]);

// Submits a query to Athena and returns the queryExecutionId.
// No ResultConfiguration.OutputLocation — omitting it makes Athena store
// results in Athena-owned managed storage (engine v3+) instead of a bucket we
// have to own, secure, and keep in the workgroup's region. We only ever read
// results back through GetQueryResults, never touch the underlying files
// directly, so managed storage is a strict improvement here.
//
// No ResultReuseConfiguration either — AWS does not support query result
// reuse on workgroups with managed query results enabled ("Query Result Reuse
// is not supported in workgroups with ManagedQueryResultsConfiguration
// enabled"), so the two features are mutually exclusive here.
const startQuery = async (sql: string, database: string): Promise<string> => {
  const input: StartQueryExecutionCommandInput = {
    QueryString: sql,
    QueryExecutionContext: { Database: database },
  };

  logger.info(`[athena] StartQueryExecution request | ${JSON.stringify(input)}`);

  const response = await athena.send(new StartQueryExecutionCommand(input));

  logger.info(
    `[athena] StartQueryExecution response | queryExecutionId:${response.QueryExecutionId} ` +
    `requestId:${response.$metadata.requestId} httpStatusCode:${response.$metadata.httpStatusCode}`
  );

  if (!response.QueryExecutionId) {
    throw new Error('[athena] StartQueryExecution returned no QueryExecutionId');
  }

  return response.QueryExecutionId;
};

// Polls Athena until the query reaches a terminal state or the timeout is exceeded.
// Throws if the query fails, is cancelled, or times out.
const waitForQuery = async (queryExecutionId: string): Promise<void> => {
  const started = Date.now();
  const deadline = started + QUERY_TIMEOUT_MS;
  let interval = POLL_INITIAL_MS;
  let poll = 0;

  // Initial settle wait before the first status check.
  await new Promise((resolve) => setTimeout(resolve, POLL_FIRST_MS));

  while (Date.now() < deadline) {
    poll += 1;
    const { QueryExecution } = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );

    const state = QueryExecution?.Status?.State;

    logger.info(
      `[athena] GetQueryExecution poll #${poll} | queryExecutionId:${queryExecutionId} ` +
      `state:${state} elapsedMs:${Date.now() - started}`
    );

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
  let page = 0;

  do {
    page += 1;
    const { ResultSet, NextToken, $metadata } = await athena.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
      })
    );

    const resultRows = ResultSet?.Rows ?? [];

    logger.info(
      `[athena] GetQueryResults page ${page} | queryExecutionId:${queryExecutionId} ` +
      `rowsInPage:${resultRows.length} rowsSoFar:${rows.length} hasNextToken:${Boolean(NextToken)} ` +
      `requestId:${$metadata.requestId} httpStatusCode:${$metadata.httpStatusCode}`
    );

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
// Results land in Athena-owned managed storage (see startQuery) — nothing to
// configure or own on our side.
// `maxRows` caps how many rows are pulled back; the returned queryExecutionId
// lets a later request replay the same rows via fetchStoredResults.
export const runAthenaQuery = async (
  sql: string,
  database: string,
  maxRows?: number
): Promise<IQueryResult> => {
  logger.info(`[athena] executing query | database:${database} sql:${sql}`);

  const queryExecutionId = await startQuery(sql, database);

  logger.info(`[athena] query submitted | queryExecutionId:${queryExecutionId}`);

  await waitForQuery(queryExecutionId);

  const result = await fetchQueryResults(queryExecutionId, maxRows);

  logger.info(
    `[athena] query complete | queryExecutionId:${queryExecutionId} rows:${result.rows.length}`
  );

  return result;
};
