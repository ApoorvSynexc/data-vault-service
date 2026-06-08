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

// ── Dry-run result types ──────────────────────────────────────────────────────

export interface IDryRunObjectResult {
  id: string;
  name: string;
  count: number | null;
  success: boolean;
  error?: string;
  children?: IDryRunObjectResult[];
}

export interface IDryRunResult {
  objects: IDryRunObjectResult[];
}

// ── validate-soql types ───────────────────────────────────────────────────────

export interface IValidateSoqlObject {
  name: string;
  condition?: ICondition;
  field?: IFieldFilter[];
}

export interface IValidateSoqlPayload {
  crmId: string;
  object: IValidateSoqlObject;
  isParent: boolean;
}

export interface IValidateSoqlItem {
  whereClause: string | null;
  isValid: boolean;
  error?: string;
}
