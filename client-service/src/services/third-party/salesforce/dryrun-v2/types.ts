// Shared object/condition/field shapes for the dry-run-v2 flow — used both
// here (soql-generation, index) and by archival-config's own object-tree
// endpoints, which build the same shape when previewing/validating before
// save. Moved from the now-retired dry-run (v1) module, which this
// superseded; only the types that actually had consumers outside that
// module survived the move.

export type SalesforceObjectType = 'CUSTOM' | 'STANDARD';

// INCLUDES/EXCLUDES are Multi-Select Picklist's own operators — Salesforce
// has no other way to test membership against that field type.
// Kept in sync with archival-v2's ALLOWED_OPERATORS (backup-service) — the
// Joi schema (constant/index.ts's FILTER_OPERATOR) already allowed
// >/</>=/<= at save time while this type (and soql-generation.ts's own
// ALLOWED_OPERATORS) didn't, so a saved filter using one could pass
// validation and then fail Dry Run with "Disallowed SOQL operator".
export type FilterOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN' | 'NOT IN' | 'INCLUDES' | 'EXCLUDES';

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
