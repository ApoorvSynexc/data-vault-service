// ── Payload types ─────────────────────────────────────────────────────────────

export type SalesforceObjectType = 'CUSTOM' | 'STANDARD';

export type FilterOperator = '=' | '!=' | 'LIKE' | 'IN';

export interface IFieldFilter {
  name: string;
  filter: {
    value: string;
    operator: FilterOperator;
  };
}

export type ICondition =
  | { type: 'AND' }
  | { type: 'OR' }
  | { type: 'CUSTOM'; expression: string }
  | { type: 'SOQL'; soqlQuery: string };

export interface ISalesforceObject {
  id: string;
  name: string;
  type: SalesforceObjectType;
  fieldApiName?: string;
  condition?: ICondition;
  field?: IFieldFilter[];
  children?: ISalesforceObject[];
}

export interface IDryRunPayload {
  crmId: string;
  objects: ISalesforceObject[];
}

// ── Engine internal types ─────────────────────────────────────────────────────

export interface IOccurrence extends ISalesforceObject {
  parentObjectName: string | null;
  depth: number;
  ancestorChain: ISalesforceObject[];
}

export interface IGraphNode {
  occurrences: IOccurrence[];
  dependsOn: Set<string>;
}

export type IExecutionGraph = Map<string, IGraphNode>;

export interface IPivotResult {
  crossObjectAncestors: number[];
  idHarvestAncestors: number[];
}

export interface ICountItem {
  key: string;
  apiName: string;
  whereClause: string;
}

export interface ICountResult {
  key: string;
  apiName: string;
  recordCount: number | null;
  success: boolean;
  errorMessage?: string;
  errorCode?: string;
}

export type IDryRunResult = Record<string, number>;

// ── validate-soql types ───────────────────────────────────────────────────────

export interface IValidateSoqlItem {
  whereClause: string | null;
  isValid: boolean;
  error?: string;
}

export type IValidateSoqlResult = Record<string, IValidateSoqlItem>;
