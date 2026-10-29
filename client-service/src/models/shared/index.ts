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

// One set of AWS credentials. For a role destination these are temporary: they come with a
// sessionToken and an expiration time.
export interface IAwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface IAwsCredentials {
  region: string;
  // Either fixed credentials, or a function the AWS SDK calls whenever it needs them. With a
  // function, the SDK asks again when a temporary pass is about to expire.
  credentials?: IAwsCredentialIdentity | (() => Promise<IAwsCredentialIdentity>);
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