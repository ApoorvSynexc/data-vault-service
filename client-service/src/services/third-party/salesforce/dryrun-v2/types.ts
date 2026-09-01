// Shared object/condition/field shapes for the dry-run-v2 flow — used both
// here (soql-generation, index) and by archival-config's own object-tree
// endpoints, which build the same shape when previewing/validating before
// save. Moved from the now-retired dry-run (v1) module, which this
// superseded; only the types that actually had consumers outside that
// module survived the move.

export type SalesforceObjectType = 'CUSTOM' | 'STANDARD';

export type FilterOperator = '=' | '!=' | 'LIKE' | 'IN';

export interface IFieldFilter {
  name: string;
  dataType: string;
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
