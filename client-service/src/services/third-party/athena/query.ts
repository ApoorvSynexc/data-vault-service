import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { AWS_REGION, AWS_ATHENA_ACCESS_KEY, AWS_ATHENA_SECRET_KEY, AWS_ATHENA_OUTPUT_LOCATION } from '../../../constant';
import { logger } from '../../../middlewares';

const athena = new AthenaClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ATHENA_ACCESS_KEY,
    secretAccessKey: AWS_ATHENA_SECRET_KEY,
  },
});

// How long to wait between each poll for query completion (ms).
const POLL_INTERVAL_MS = 1000;

// Maximum total time to wait for a query to finish before giving up (ms).
const QUERY_TIMEOUT_MS = 60_000;

const TERMINAL_STATES = new Set<QueryExecutionState>([
  QueryExecutionState.SUCCEEDED,
  QueryExecutionState.FAILED,
  QueryExecutionState.CANCELLED,
]);

// Submits a query to Athena and returns the queryExecutionId.
const startQuery = async (sql: string, database: string): Promise<string> => {
  const { QueryExecutionId } = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: { Database: database },
      ResultConfiguration: { OutputLocation: AWS_ATHENA_OUTPUT_LOCATION },
    })
  );

  if (!QueryExecutionId) {
    throw new Error('[athena] StartQueryExecution returned no QueryExecutionId');
  }

  return QueryExecutionId;
};

// Polls Athena until the query reaches a terminal state or the timeout is exceeded.
// Throws if the query fails, is cancelled, or times out.
const waitForQuery = async (queryExecutionId: string): Promise<void> => {
  const deadline = Date.now() + QUERY_TIMEOUT_MS;

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

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`[athena] query timed out after ${QUERY_TIMEOUT_MS}ms`);
};

export interface IQueryResult {
  columns: string[];
  rows: Record<string, string>[];
}

// Fetches all result pages for a completed query and returns them as
// a flat array of row objects keyed by column name.
const fetchQueryResults = async (queryExecutionId: string): Promise<IQueryResult> => {
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
  } while (nextToken);

  return { columns, rows };
};

// Runs a SQL query against Athena, waits for completion, and returns results.
// database must be a Glue Catalog database name (e.g. datavault_<crmId>).
export const runAthenaQuery = async (sql: string, database: string): Promise<IQueryResult> => {
  logger.info(`[athena] executing query | database:${database} sql:${sql}`);

  const queryExecutionId = await startQuery(sql, database);

  logger.info(`[athena] query submitted | queryExecutionId:${queryExecutionId}`);

  await waitForQuery(queryExecutionId);

  const result = await fetchQueryResults(queryExecutionId);

  logger.info(
    `[athena] query complete | queryExecutionId:${queryExecutionId} rows:${result.rows.length}`
  );

  return result;
};
