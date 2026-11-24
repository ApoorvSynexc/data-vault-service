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

export interface IListS3ObjectsResult {
  keys: string[];
  // Pass back as `cursor` to get the next page; undefined when there are no more keys.
  nextCursor?: string;
}

/**
 * Lists one page of at most `limit` keys under `prefix` (S3 caps a page at 1000).
 * Keys come back in ascending order. If more keys exist, `nextCursor` is returned.
 */
export const listS3Objects = async (
  config: S3Config,
  prefix: string,
  limit = 1000,
  cursor?: string
): Promise<IListS3ObjectsResult> => {
  const client = getS3Client(config);

  try {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: prefix,
        MaxKeys: limit,
        ...(cursor ? { ContinuationToken: cursor } : {}),
      })
    );

    const keys = (result.Contents ?? []).flatMap((obj) => (obj.Key ? [obj.Key] : []));
    return {
      keys,
      nextCursor: result.IsTruncated ? result.NextContinuationToken : undefined,
    };
  } finally {
    client.destroy();
  }
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
