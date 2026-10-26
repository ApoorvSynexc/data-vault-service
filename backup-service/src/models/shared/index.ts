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

// Mirrors client-service/src/models/shared/index.ts's IMedia.
export interface IMedia {
  name?: string;
  thumbnailUrl?: string;
  url?: string;
  type?: string;
  size?: number;
}
