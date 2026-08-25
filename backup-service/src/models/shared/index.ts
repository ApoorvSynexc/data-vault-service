export interface IAwsCredentials {
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export interface IS3ObjectKey {
  objectId: string;
  key: string;
}
