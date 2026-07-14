import { SalesforceTokens } from './index';

export interface MetadataListEntry {
  fullName: string;
  namespacePrefix?: string;
  manageableState?: string;
}

/**
 * Minimal SOAP client for the Metadata API's listMetadata() call — the only
 * officially supported way to enumerate existing components of a metadata
 * type without already knowing their fullName in advance.
 *
 * Deliberately NOT Tooling API: types like ExternalClientApplication aren't
 * in Tooling API's queryable object list at all (confirmed against
 * Salesforce's own Tooling API object reference — only the unrelated,
 * internal-use-only ExternalClientAppSettings appears there) and querying
 * them via /tooling/query returns INVALID_TYPE regardless of org or API
 * version. Not SOQL/REST sobjects either — packageable metadata types like
 * this aren't data objects.
 *
 * SOAP session auth: the Metadata API's SOAP endpoint takes the session
 * identifier inside a <SessionHeader><sessionId> element, not an HTTP
 * Authorization header. A valid OAuth access_token works interchangeably as
 * a SOAP session ID here — standard, documented Salesforce behavior, not a
 * workaround.
 */
export const listMetadataSoap = async (
  instanceUrl: string,
  tokens: SalesforceTokens,
  metadataType: string,
  apiVersion: string
): Promise<MetadataListEntry[]> => {
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">\n` +
    `  <soapenv:Header>\n` +
    `    <met:SessionHeader><met:sessionId>${tokens.accessToken}</met:sessionId></met:SessionHeader>\n` +
    `  </soapenv:Header>\n` +
    `  <soapenv:Body>\n` +
    `    <met:listMetadata>\n` +
    `      <met:queries><met:type>${metadataType}</met:type></met:queries>\n` +
    `      <met:asOfVersion>${apiVersion}</met:asOfVersion>\n` +
    `    </met:listMetadata>\n` +
    `  </soapenv:Body>\n` +
    `</soapenv:Envelope>`;

  // Native fetch, not the shared httpRequest helper — httpRequest hardcodes
  // JSON request/response handling (see metadata-api.ts's deployMetadata for
  // the same reasoning on its multipart call); this is XML both ways.
  const response = await fetch(`${instanceUrl}/services/Soap/m/${apiVersion}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      SOAPAction: '""',
    },
    body: envelope,
  });

  const bodyText = await response.text();

  if (!response.ok || bodyText.includes('<soapenv:Fault>')) {
    const faultMessage = bodyText.match(/<faultstring>([^<]*)<\/faultstring>/)?.[1];
    throw new Error(`metadata_listmetadata_failed: ${faultMessage ?? `HTTP ${response.status}`}`);
  }

  // listMetadata's <result> blocks are flat (fullName / namespacePrefix /
  // manageableState are simple, non-repeating text nodes), so a scoped
  // regex extraction per block is safe for this one narrow, well-known
  // response shape without pulling in a full XML parser dependency.
  const entries: MetadataListEntry[] = [];
  const resultBlocks = bodyText.match(/<result>[\s\S]*?<\/result>/g) ?? [];
  for (const block of resultBlocks) {
    const fullName = block.match(/<fullName>([^<]*)<\/fullName>/)?.[1];
    if (!fullName) {
      continue;
    }
    entries.push({
      fullName,
      namespacePrefix: block.match(/<namespacePrefix>([^<]*)<\/namespacePrefix>/)?.[1],
      manageableState: block.match(/<manageableState>([^<]*)<\/manageableState>/)?.[1],
    });
  }
  return entries;
};
