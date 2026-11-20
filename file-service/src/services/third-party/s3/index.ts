import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
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

export const downloadFromS3 = async (config: S3Config, key: string): Promise<Readable> => {
  const client = getS3Client(config);

  try {
    const { Body } = await client.send(
      new GetObjectCommand({ Bucket: config.bucketName, Key: key })
    );
    if (!(Body instanceof Readable)) {
      throw new Error(`Unexpected S3 response body for key: ${key}`);
    }
    Body.once('close', () => client.destroy());
    return Body;
  } catch (error) {
    client.destroy();
    throw error;
  }
};

/**
 * Uploads `body` to S3 at `key` with a multipart upload. A stream is sent in
 * parts as it is read, so a large file is never held in memory whole
 * (roughly partSize x queueSize at a time). A failed upload is aborted so no
 * partial parts are left behind.
 */
export const uploadToS3 = async (
  config: S3Config,
  key: string,
  body: Readable | Buffer | string,
  contentType?: string
): Promise<string> => {
  const client = getS3Client(config);

  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: config.bucketName,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
    return `s3://${config.bucketName}/${key}`;
  } finally {
    client.destroy();
  }
};
