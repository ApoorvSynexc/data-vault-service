export interface IAwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface IAwsCredentials {
  region: string;
  // A function is used for role destinations: the SDK calls it to get a fresh temporary pass.
  credentials?: IAwsCredentialIdentity | (() => Promise<IAwsCredentialIdentity>);
}

export interface IS3ObjectKey {
  objectId: string;
  key: string;
}

// Mirrors client-service/src/models/shared/index.ts's IMedia.
export interface IMedia {
  name?: string;
  thumbnailUrl?: string;
  url?: string;
  type?: string;
  size?: number;
}
