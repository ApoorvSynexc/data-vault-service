import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AWS_REGION, S3_ROLE_SESSION_SECONDS } from '../../../constant';
import { IDestinationConfig } from '../../../models';

const ROLE_SESSION_NAME = 'datacraft-s3';

const clientCache = new Map<string, S3Client>();

const getCredentials = (config: IDestinationConfig) => {
  if (config.authType === 'ASSUME_ROLE') {
    if (!config.roleArn || !config.externalId) {
      throw new Error('invalid_role_destination');
    }
    return fromTemporaryCredentials({
      params: {
        RoleArn: config.roleArn,
        ExternalId: config.externalId,
        RoleSessionName: ROLE_SESSION_NAME,
        DurationSeconds: S3_ROLE_SESSION_SECONDS,
      },
      clientConfig: { region: AWS_REGION },
    });
  }
  return {
    accessKeyId: config.accessKeyId as string,
    secretAccessKey: config.secretAccessKey as string,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
};

const getS3Client = (config: IDestinationConfig): S3Client => {
  const identity =
    config.authType === 'ASSUME_ROLE'
      ? `role:${config.roleArn}:${config.externalId}`
      : `key:${config.accessKeyId}`;
  const cacheKey = `${config.region}:${identity}:${config.bucketName}`;

  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({ region: config.region, credentials: getCredentials(config) });
    clientCache.set(cacheKey, client);
  }
  return client;
};

export const listS3Objects = async (
  config: IDestinationConfig,
  prefix: string
): Promise<string[]> => {
  const client = getS3Client(config);

  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) {
        keys.push(obj.Key);
      }
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);

  return keys.sort();
};
