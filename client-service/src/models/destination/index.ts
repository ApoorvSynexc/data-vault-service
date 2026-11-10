// How DataCraft proves who it is to the customer's bucket.
//   ACCESS_KEYS : legacy. The customer gave us an access key + secret key.
//   ASSUME_ROLE : the customer created an IAM role that trusts DataCraft's AWS account.
//                 We store only the role address + an External ID, never a password.
export type S3AuthType = 'ACCESS_KEYS' | 'ASSUME_ROLE';

export interface IS3Config {
  bucketName: string;
  region: string;
  folderPath?: string;
  // A missing authType means a destination saved before role support existed: ACCESS_KEYS.
  authType?: S3AuthType;
  // ASSUME_ROLE
  roleArn?: string;
  externalId?: string;
  // ACCESS_KEYS (legacy). Also filled with short-lived values plus sessionToken when a role has
  // been resolved for a job that must hand credentials to another system.
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface IDestination {
  destinationId: string; // PK
  userId: string; // GSI: userId-index
  name: string;
  provider: 'AWS' | 'AZURE' | 'GCP';
  type: string; // S3 | (future: BLOB, GCS)
  cipherText: string; // encrypted credentials
  iv: string;
  authTag: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
