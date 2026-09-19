import {
  AthenaClient,
  StartQueryExecutionCommand,
  StartQueryExecutionCommandInput,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { AWS_ATHENA_ROLE_ARN } from '../../../constant';
import { logger } from '../../../middlewares';

// One AthenaClient per region, not one global client: Athena is a regional
// service, and a query must run in the same region as the client's own S3
// bucket the Glue table's data lives in — never the platform's own default
// region, which may not match. Keyless: no static access/secret key, ever —
// the SDK's default credential provider chain resolves to whatever IAM role
// the running environment has (ECS task role, EC2 instance role, etc.).
const athenaClients = new Map<string, AthenaClient>();
const getAthenaClient = (region: string): AthenaClient => {
  let client = athenaClients.get(region);
  if (!client) {
    client = new AthenaClient({ region });
    athenaClients.set(region, client);
  }
  return client;
};

// Adaptive polling: wait POLL_FIRST_MS before the first status check, then
// poll on a 250ms→2s backoff ladder. These compressed Hudi/delta tables are
// small and partition-pruned, so queries routinely finish under 1s — a 2s
// first-wait was pure dead time on the common case. 400ms still avoids
// hammering GetQueryExecution; slower queries just climb the backoff ladder.
const POLL_FIRST_MS = 400;
const POLL_INITIAL_MS = 250;
const POLL_MAX_MS = 2000;

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
// `outputLocation` is the client's own bucket
// (s3://{bucket}/{backupConfigId}/retrieve/ — see buildRetrieveOutputLocation),
// so result files land with the data they came from and the client owns their
// lifecycle. Omitted only when the config has no resolvable S3 destination, in
// which case Athena falls back to the workgroup's own result setting.
//
// No ResultReuseConfiguration — AWS does not support query result reuse on
// workgroups with managed query results enabled, so the two features are
// mutually exclusive here.
const startQuery = async (
  sql: string,
  database: string,
  region: string,
  outputLocation?: string
): Promise<string> => {
  const input: StartQueryExecutionCommandInput = {
    QueryString: sql,
    QueryExecutionContext: { Database: database },
    ...(outputLocation && { ResultConfiguration: { OutputLocation: outputLocation } }),
  };

  logger.info(`[athena] StartQueryExecution request | ${JSON.stringify(input)}`);

  // Wall-clock around just the send() call, plus the SDK's own retry
  // accounting ($metadata.attempts/totalRetryDelay) — together these tell
  // apart "AWS was slow to respond" (elapsedMs high, attempts:1) from
  // "the SDK silently retried/backed off" (totalRetryDelay accounts for most
  // of elapsedMs) from "the request took long to leave this host" (elapsedMs
  // high but AWS's own requestId/CloudTrail timing is short). requestId is
  // already logged below — cross-reference it in CloudTrail for the
  // server-side view.
  const sendStartedAt = Date.now();
  const response = await getAthenaClient(region).send(new StartQueryExecutionCommand(input));
  const sendElapsedMs = Date.now() - sendStartedAt;

  logger.info(
    `[athena] StartQueryExecution response | queryExecutionId:${response.QueryExecutionId} ` +
    `requestId:${response.$metadata.requestId} httpStatusCode:${response.$metadata.httpStatusCode} ` +
    `sendElapsedMs:${sendElapsedMs} attempts:${response.$metadata.attempts ?? 'n/a'} ` +
    `totalRetryDelayMs:${response.$metadata.totalRetryDelay ?? 'n/a'}`
  );

  if (!response.QueryExecutionId) {
    throw new Error('[athena] StartQueryExecution returned no QueryExecutionId');
  }

  return response.QueryExecutionId;
};

// Polls Athena until the query reaches a terminal state or the timeout is exceeded.
// Throws if the query fails, is cancelled, or times out.
const waitForQuery = async (queryExecutionId: string, region: string): Promise<void> => {
  const started = Date.now();
  const deadline = started + QUERY_TIMEOUT_MS;
  let interval = POLL_INITIAL_MS;
  let poll = 0;

  // Initial settle wait before the first status check.
  await new Promise((resolve) => setTimeout(resolve, POLL_FIRST_MS));

  while (Date.now() < deadline) {
    poll += 1;
    const { QueryExecution } = await getAthenaClient(region).send(
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
        // Logged here, not just embedded in the thrown error: a caller
        // upstream (e.g. makeRunner's `run`) may match this message against
        // /does not exist/i and swallow it as "table not compressed yet",
        // which would otherwise hide a genuinely different failure (wrong
        // region, permissions, a malformed query) behind a silent empty result.
        logger.error(
          `[athena] query ${state} | queryExecutionId:${queryExecutionId} region:${region} reason:${reason}`
        );
        throw new Error(`[athena] query ${state} | reason: ${reason}`);
      }
      // Athena's own timing breakdown — the only way to tell "small data, slow
      // query" apart without guessing: a high queueMs points at DPU/workgroup
      // capacity contention, a high planningMs points at partition/file-listing
      // overhead (often many small files), and a high engineExecMs with a low
      // dataScannedBytes points at read-side cost (e.g. Merge-on-Read Hudi
      // merging base+log files) rather than genuine data volume.
      const stats = QueryExecution?.Statistics;
      logger.info(
        `[athena] query stats | queryExecutionId:${queryExecutionId} ` +
        `queueMs:${stats?.QueryQueueTimeInMillis ?? 'n/a'} ` +
        `planningMs:${stats?.QueryPlanningTimeInMillis ?? 'n/a'} ` +
        `engineExecMs:${stats?.EngineExecutionTimeInMillis ?? 'n/a'} ` +
        `serviceProcessingMs:${stats?.ServiceProcessingTimeInMillis ?? 'n/a'} ` +
        `totalMs:${stats?.TotalExecutionTimeInMillis ?? 'n/a'} ` +
        `dataScannedBytes:${stats?.DataScannedInBytes ?? 'n/a'}`
      );
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
  region: string,
  maxRows = Infinity
): Promise<IQueryResult> => {
  const columns: string[] = [];
  const rows: Record<string, string>[] = [];
  let nextToken: string | undefined;
  let isFirstPage = true;
  let page = 0;

  do {
    page += 1;
    const { ResultSet, NextToken, $metadata } = await getAthenaClient(region).send(
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
 * set at the query's output location, so reading it back scans no data and
 * costs nothing beyond an S3 GET. It also skips the ~2s submit/poll settle, so
 * a replayed page returns in a fraction of the time a fresh query takes.
 *
 * Throws if the execution id has expired (Athena retains query metadata ~45
 * days) or its result file is gone — including when the client's own lifecycle
 * rules expired it out of their bucket — callers treat that as "cursor expired".
 */
export const fetchStoredResults = async (
  queryExecutionId: string,
  region: string,
  maxRows?: number
): Promise<IQueryResult> => {
  const result = await fetchQueryResults(queryExecutionId, region, maxRows);
  logger.info(
    `[athena] result replay | queryExecutionId:${queryExecutionId} rows:${result.rows.length}`
  );
  return result;
};

// Runs a SQL query against Athena, waits for completion, and returns results.
// database must be a Glue Catalog database name (e.g. the backupConfigId).
// `region` is the client's own S3 bucket region — Athena is regional, and a
// query must run in the same region as the Glue table's underlying S3 data,
// never the platform's own default region.
// `outputLocation` is where Athena writes the result file (see startQuery).
// `maxRows` caps how many rows are pulled back; the returned queryExecutionId
// lets a later request replay the same rows via fetchStoredResults.
export const runAthenaQuery = async (
  sql: string,
  database: string,
  region: string,
  outputLocation?: string,
  maxRows?: number
): Promise<IQueryResult> => {
  logger.info(
    `[athena] executing query | database:${database} region:${region} outputLocation:${outputLocation ?? 'workgroup-default'} sql:${sql}`
  );

  const queryExecutionId = await startQuery(sql, database, region, outputLocation);

  logger.info(`[athena] query submitted | queryExecutionId:${queryExecutionId}`);

  await waitForQuery(queryExecutionId, region);

  const result = await fetchQueryResults(queryExecutionId, region, maxRows);

  logger.info(
    `[athena] query complete | queryExecutionId:${queryExecutionId} rows:${result.rows.length}`
  );
  logger.info(
    `[athena] results | details : ${JSON.stringify(result)}`
  );
  return result;
};
