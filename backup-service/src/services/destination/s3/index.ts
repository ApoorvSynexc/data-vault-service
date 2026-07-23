import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { IDestinationConfig } from '../../../models';

// ---------------------------------------------------------------------------
// One S3Client per unique destination (region + credentials + bucket).
// Reusing the client lets the AWS SDK pool HTTP connections across calls
// instead of opening a new TLS handshake on every upload/download/list.
// ---------------------------------------------------------------------------
const clientCache = new Map<string, S3Client>();

const getS3Client = (config: IDestinationConfig): S3Client => {
  const cacheKey = `${config.region}:${config.accessKeyId}:${config.bucketName}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    clientCache.set(cacheKey, client);
  }
  return client;
};

// Lists immediate child "folder" prefixes under a prefix (delimiter listing) —
// e.g. year=2026/, year=2025/ — without enumerating every object beneath them.
export const listS3Prefixes = async (
  config: IDestinationConfig,
  prefix: string
): Promise<string[]> => {
  const client = getS3Client(config);

  const prefixes: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: prefix,
        Delimiter: '/',
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })
    );
    for (const p of result.CommonPrefixes ?? []) {
      if (p.Prefix) {
        prefixes.push(p.Prefix);
      }
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);

  return prefixes.sort();
};

export const uploadToS3 = async (
  config: IDestinationConfig,
  key: string,
  body: Buffer
): Promise<string> => {
  const client = getS3Client(config);

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: body,
      ContentType: 'text/csv',
    })
  );

  return `s3://${config.bucketName}/${key}`;
};

export const downloadFromS3 = async (
  config: IDestinationConfig,
  key: string
): Promise<Buffer | null> => {
  const client = getS3Client(config);

  try {
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err: any) {
    if (err.name === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
};

export const fetchCsvFromS3 = async (
  config: IDestinationConfig,
  key: string
): Promise<{ csvData: string; recordCount: number }> => {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  try {
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
    const csvData = (await result.Body?.transformToString()) || '';
    const lines = csvData.split('\n').filter((line) => line.trim());
    const recordCount = Math.max(0, lines.length - 1);

    if (!lines[0]?.toLowerCase().includes('id')) {
      throw new Error('CSV must contain Id column');
    }

    return { csvData, recordCount };
  } catch (err: any) {
    if (err.name === 'NoSuchKey') {
      throw new Error(`S3 file not found: ${key}`, { cause: err });
    }
    throw new Error(`Failed to fetch S3 file: ${err.message}`, { cause: err });
  }
};

// Deletes all keys listed in `keys` from the bucket, batched at 1,000 per request.
export const deleteS3Objects = async (
  config: IDestinationConfig,
  keys: string[]
): Promise<void> => {
  if (!keys.length) {
    return;
  }
  const client = getS3Client(config);
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.bucketName,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
    );
  }
};

// Lists all keys under prefix then deletes them — used to wipe stale error logs before re-upload.
export const listAndDeleteS3Prefix = async (
  config: IDestinationConfig,
  prefix: string
): Promise<void> => {
  const keys = await listS3Objects(config, prefix);
  await deleteS3Objects(config, keys);
};

// Returns all S3 object keys under a given prefix, sorted alphabetically.
// Paginates through all pages (each page capped at 1,000 keys by the S3 API).
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
