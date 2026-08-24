import { SALESFORCE_NAMESPACE } from '../constant';

// Apex REST base path for the DataVault package's endpoints. A subscriber org
// (package installed under a namespace) exposes them under
// /services/apexrest/{namespace}/v1/data-vault; an unpackaged dev/scratch org
// (namespace unset) exposes them directly under /services/apexrest/v1/data-vault.
// `namespace` defaults to the configured SALESFORCE_NAMESPACE — the param
// exists so this stays a pure, directly testable function.
export const apexRestBase = (
  instanceUrl: string,
  namespace: string = SALESFORCE_NAMESPACE
): string => `${instanceUrl}/services/apexrest/${namespace ? `${namespace}/` : ''}v1/data-vault`;
