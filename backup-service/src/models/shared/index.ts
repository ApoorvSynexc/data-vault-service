export interface IAwsCredentials {
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string
  }
}