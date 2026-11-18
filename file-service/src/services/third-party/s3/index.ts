import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { IDestinationConfig } from '../../../models';

type S3Config = Pick<
  IDestinationConfig,
  'bucketName' | 'region' | 'accessKeyId' | 'secretAccessKey'
>;

const getS3Client = ({ region, accessKeyId, secretAccessKey }: S3Config): S3Client =>
  new S3Client({
    region,
    credentials: {
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
    },
  });

export const listS3Objects = async (config: S3Config, prefix: string): Promise<string[]> => {
  const client = getS3Client(config);

  const keys: string[] = [];
  let continuationToken: string | undefined;

  try {
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
  } finally {
    client.destroy();
  }

  return keys.sort();
};
