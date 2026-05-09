export interface IS3Config {
  bucketName: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  folderPath?: string;
}

export interface IDestination {
  destinationId: string; // PK
  userId: string; // GSI: userId-index
  name: string;
  provider: 'AWS' | 'AZURE' | 'GCP';
  type: string; // S3 | (future: BLOB, GCS)
  ciphertext: string; // encrypted credentials
  iv: string;
  status: string;
  spaceId?: string;
  createdAt: string;
  updatedAt: string;
}
