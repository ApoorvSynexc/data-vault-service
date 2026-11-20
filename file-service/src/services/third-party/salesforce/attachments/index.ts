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
}

interface IQueryResult<T> {
  records: T[];
  done: boolean;
  nextRecordsUrl?: string;
}

export interface IContentDocumentLinkPage {
  records: IContentDocumentLink[];
  // Set when more rows exist; pass it back to fetch the next page. null = last page.
  nextRecordsUrl: string | null;
}

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

/**
 * Files linked to a record: one row per ContentDocument attached to `recordId`.
 * Salesforce returns up to 2000 rows per page. When more exist, `nextRecordsUrl`
 * is set; pass it back as the third argument to get the next page.
 */
const getContentDocumentLinks = async (
  context: ISalesforceContext,
  recordId: string,
  nextRecordsUrl?: string
): Promise<IContentDocumentLinkPage> => {
  let result: IQueryResult<IContentDocumentLink>;

  if (nextRecordsUrl) {
    if (!nextRecordsUrl.startsWith('/services/data/')) {
      throw new Error(`Invalid nextRecordsUrl: ${nextRecordsUrl}`);
    }
    result = await salesforceRequest<IQueryResult<IContentDocumentLink>>(
      { url: `${context.instanceUrl}${nextRecordsUrl}` },
      context.tokens
    );
  } else {
    assertSalesforceId(recordId);
    result = await query<IContentDocumentLink>(
      context,
      `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId = '${recordId}'`
    );
  }

  return {
    records: result.records,
    nextRecordsUrl: !result.done && result.nextRecordsUrl ? result.nextRecordsUrl : null,
  };
};

/** Latest published version of a file (its metadata), or null if none exists. */
const getContentVersion = async (
  context: ISalesforceContext,
  contentDocumentId: string,
): Promise<any | null> => {
  assertSalesforceId(contentDocumentId);
  const records = await query<IContentVersion>(
    context,
    `SELECT Id, ContentDocumentId, Title, FileExtension, FileType, IsLatest, LastModifiedDate, ContentSize FROM ContentVersion WHERE ContentDocumentId = '${contentDocumentId}'`
  );
  console.log(JSON.stringify({records}))
  return records ?? null;
};

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

export { getContentDocumentLinks, getContentVersion, getContentBinary };
