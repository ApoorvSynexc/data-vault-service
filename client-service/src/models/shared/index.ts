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