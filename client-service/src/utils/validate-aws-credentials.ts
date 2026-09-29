import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

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

export { validateS3Credentials };
