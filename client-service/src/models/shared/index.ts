import type { IScheduleConfig } from '../backup-config';

export interface IAddress {
  street?: string;
  street2?: string;
  city?: string;
  cityId?: string;
  state?: string;
  stateIso2?: string;
  stateId?: string;
  country?: string;
  iso2?: string;
  countryId?: string;
  zipCode?: string;
  geo?: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
}

export interface IMedia {
  name?: string;
  thumbnailUrl?: string;
  url?: string;
  type?: string;
  size?: number;
}

export interface IAwsCredentials {
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string
  }
}

export interface IObjectField {
  name: string;
  dataType: string;
  filter: IFieldFilter;
}

export interface IFieldFilter {
  operator: string;
  value: any;
}

export interface IObjectCondition {
  type: string; // AND | OR | NOT | CUSTOM | SOQL
  expression?: string; // required when type === CUSTOM, e.g. "1 AND 2 OR 3"
  soqlQuery?: string; // required when type === SOQL
}

export interface IObjectParent {
  id: string;
  name: string;
}

// skipReason/skipDateTime are only meaningful while skip is true — once the
export interface IUpcomingJob {
  skip: boolean;
  skipReason?: string;
  skipDateTime?: string;
}

export interface IObjectRelationshipNode {
  id: string;
  name: string;
  fieldName?: string;
  children?: IObjectRelationshipNode[];
}

export interface IObject {
  id: string;
  name: string;
  type: string; // STANDARD | CUSTOM

  // optional
  children?: IObjectRelationshipNode[];
  schemaChange?: boolean;
  totalRecordCount?: number;
  status?: string;
  fieldName?: string;
  isUserSelected?: boolean;
  sizeInBytes?: number;
  field?: IObjectField[];
  condition?: IObjectCondition;
  scheduleConfig?: IScheduleConfig;
  parentObjects?: IObjectParent[];
  upcomingJob?: IUpcomingJob;
}