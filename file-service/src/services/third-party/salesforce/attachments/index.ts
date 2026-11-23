import { Readable } from 'stream';
import { SALESFORCE_API_VERSION } from '../../../../constant';
import { salesforceFetch, salesforceRequest, SalesforceTokens } from '../common';

interface ISalesforceContext {
  instanceUrl: string;
  tokens: SalesforceTokens;
}

export interface IContentDocumentLink {
  ContentDocumentId: string;
  LinkedEntityId: string;
}

export interface IContentVersion {
  Id: string;
  ContentDocumentId: string;
  Title: string;
  FileExtension: string | null;
  FileType: string | null;
  ContentSize: number;
  IsLatest: boolean;
  LastModifiedDate: string;
}

export interface IContentDocument {
  Id: string;
  Title: string;
  FileExtension: string | null;
  FileType: string | null;
  ContentSize: number;
  LatestPublishedVersionId: string | null;
  OwnerId: string;
  IsArchived: boolean;
  CreatedDate: string;
  LastModifiedDate: string;
}

interface IQueryResult<T> {
  records: T[];
  done: boolean;
  nextRecordsUrl?: string;
}

export interface IQueryPage<T> {
  records: T[];
  // Set when more rows exist; pass it back to fetch the next page. null = last page.
  nextRecordsUrl: string | null;
}

export type IContentDocumentLinkPage = IQueryPage<IContentDocumentLink>;

// Salesforce ids are 15 or 18 alphanumeric characters. Validated because the id
// is interpolated into SOQL / the URL path.
const assertSalesforceId = (id: string): void => {
  if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
    throw new Error(`Invalid Salesforce id: ${id}`);
  }
};

const query = <T>(
  { instanceUrl, tokens }: ISalesforceContext,
  soql: string
): Promise<IQueryResult<T>> =>
  salesforceRequest<IQueryResult<T>>(
    { url: `${instanceUrl}/services/data/${SALESFORCE_API_VERSION}/query`, query: { q: soql } },
    tokens
  );

// The ids go in the query string of a GET request, so the list has to stay under
// the URL length limit (about 16 KB; each quoted id is ~21 characters).
const MAX_IDS_PER_QUERY = 500;

// Runs a SOQL query that filters on a list of ids (`buildSoql` receives the quoted,
// comma separated list). Salesforce returns up to 2000 rows per page; when more
// exist `nextRecordsUrl` is set, and passing it back fetches the next page.
const queryByIds = async <T>(
  context: ISalesforceContext,
  ids: string[],
  buildSoql: (idList: string) => string,
  nextRecordsUrl?: string
): Promise<IQueryPage<T>> => {
  let result: IQueryResult<T>;

  if (nextRecordsUrl) {
    if (!nextRecordsUrl.startsWith('/services/data/')) {
      throw new Error(`Invalid nextRecordsUrl: ${nextRecordsUrl}`);
    }
    result = await salesforceRequest<IQueryResult<T>>(
      { url: `${context.instanceUrl}${nextRecordsUrl}` },
      context.tokens
    );
  } else {
    if (ids.length === 0) {
      return { records: [], nextRecordsUrl: null };
    }
    if (ids.length > MAX_IDS_PER_QUERY) {
      throw new Error(`Too many ids (${ids.length}); send at most ${MAX_IDS_PER_QUERY} per call`);
    }
    ids.forEach(assertSalesforceId);
    result = await query<T>(context, buildSoql(ids.map((id) => `'${id}'`).join(',')));
  }

  return {
    records: result.records,
    nextRecordsUrl: !result.done && result.nextRecordsUrl ? result.nextRecordsUrl : null,
  };
};

/**
 * Files linked to the given records: one row per ContentDocument attached to any of
 * `recordIds`; `LinkedEntityId` on each row says which record it belongs to.
 */
const getContentDocumentLinks = (
  context: ISalesforceContext,
  recordIds: string[],
  nextRecordsUrl?: string
): Promise<IContentDocumentLinkPage> =>
  queryByIds<IContentDocumentLink>(
    context,
    recordIds,
    (idList) =>
      `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${idList})`,
    nextRecordsUrl
  );

/** The ContentDocument records (the files' containers) for the given ids. */
const getContentDocument = (
  context: ISalesforceContext,
  contentDocumentIds: string[],
  nextRecordsUrl?: string
): Promise<IQueryPage<IContentDocument>> =>
  queryByIds<IContentDocument>(
    context,
    contentDocumentIds,
    (idList) =>
      `SELECT Id, Title, FileExtension, FileType, ContentSize, LatestPublishedVersionId, OwnerId, IsArchived, CreatedDate, LastModifiedDate FROM ContentDocument WHERE Id IN (${idList})`,
    nextRecordsUrl
  );

/**
 * Every version of the given ContentDocuments (metadata only);
 * `ContentDocumentId` on each row says which document it belongs to.
 */
const getContentVersion = (
  context: ISalesforceContext,
  contentDocumentIds: string[],
  nextRecordsUrl?: string
): Promise<IQueryPage<IContentVersion>> =>
  queryByIds<IContentVersion>(
    context,
    contentDocumentIds,
    (idList) =>
      `SELECT Id, ContentDocumentId, Title, FileExtension, FileType, IsLatest, LastModifiedDate, ContentSize FROM ContentVersion WHERE ContentDocumentId IN (${idList})`,
    nextRecordsUrl
  );

/** Streams the file bytes (PDF, image, ...) of a ContentVersion. */
const getContentBinary = async (
  { instanceUrl, tokens }: ISalesforceContext,
  contentVersionId: string
): Promise<Readable> => {
  assertSalesforceId(contentVersionId);
  const response = await salesforceFetch(
    `${instanceUrl}/services/data/${SALESFORCE_API_VERSION}/sobjects/ContentVersion/${contentVersionId}/VersionData`,
    {},
    tokens
  );

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`HTTP Error ${response.status}: ${detail}`);
  }
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
};

export { getContentDocumentLinks, getContentDocument, getContentVersion, getContentBinary };
