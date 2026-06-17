import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

export interface S3Config {
  bucketName: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const getS3Client = (config: S3Config): S3Client =>
  new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

const validateS3Credentials = async (config: S3Config): Promise<void> => {
  await getS3Client(config).send(new HeadBucketCommand({ Bucket: config.bucketName }));
};

const listS3Keys = async (cfg: S3Config, prefix: string): Promise<string[]> => {
  const client = getS3Client(cfg);
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucketName,
        Prefix: prefix,
        ...(token ? { ContinuationToken: token } : {}),
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
};

const getS3Text = async (cfg: S3Config, key: string): Promise<string> => {
  const res = await getS3Client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucketName, Key: key }));
  return (await res.Body?.transformToString()) ?? '';
};

export { validateS3Credentials, listS3Keys, getS3Text };
