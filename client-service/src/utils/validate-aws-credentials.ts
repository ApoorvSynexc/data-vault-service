import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

interface S3Config {
  bucketName: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const validateS3Credentials = async (config: S3Config): Promise<void> => {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));
};

export { validateS3Credentials };
