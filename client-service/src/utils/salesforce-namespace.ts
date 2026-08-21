import { SALESFORCE_NAMESPACE } from '../constant';

// Prefixes a Salesforce metadata API name with the managed package namespace,
// e.g. Salary__c -> dv__Salary__c. No-op when the namespace is unset, and
// idempotent — an already-namespaced name (dv__Salary__c, or a compound
// ExternalCredential-Principal name like Middleware_Endpoint-DataVaultParam,
// since the namespace only ever prefixes the string once) passes through
// unchanged rather than getting double-prefixed.
// `namespace` defaults to the configured SALESFORCE_NAMESPACE — the param
// exists so this stays a pure, directly testable function.
export const withNamespace = (apiName: string, namespace: string = SALESFORCE_NAMESPACE): string => {
  if (!namespace) return apiName;
  const prefix = `${namespace}__`;
  return apiName.startsWith(prefix) ? apiName : `${prefix}${apiName}`;
};

// Inverse of withNamespace — strips the namespace prefix if present.
export const stripNamespace = (apiName: string, namespace: string = SALESFORCE_NAMESPACE): string => {
  if (!namespace) return apiName;
  const prefix = `${namespace}__`;
  return apiName.startsWith(prefix) ? apiName.slice(prefix.length) : apiName;
};

// Apex REST base path for the DataVault package's endpoints. A subscriber org
// (package installed under a namespace) exposes them under
// /services/apexrest/{namespace}/v1/data-vault; an unpackaged dev/scratch org
// (namespace unset) exposes them directly under /services/apexrest/v1/data-vault.
export const apexRestBase = (instanceUrl?: string, namespace: string = SALESFORCE_NAMESPACE): string =>
  `${instanceUrl}/services/apexrest/${namespace ? `${namespace.replace('__', '')}/` : ''}v1/data-vault`;
