import {
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadBucketCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IAwsCredentials, IS3Config } from '../../../models';

// ---------------------------------------------------------------------------
// One S3Client per unique destination (region + credentials + bucket).
// Reusing the client lets the AWS SDK pool HTTP connections across calls
// instead of opening a new TLS handshake on every upload/download/list.
// ---------------------------------------------------------------------------
const clientCache = new Map<string, S3Client>();
const getS3Client = (config: IS3Config): S3Client => {
    const cacheKey = `${config.region}:${config.accessKeyId}:${config.bucketName}`;
    let client = clientCache.get(cacheKey);
    if (!client) {
        const awsConfig: IAwsCredentials = {
            region: config.region
        }

        awsConfig.credentials = {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        }

        client = new S3Client(awsConfig);
        clientCache.set(cacheKey, client);
    }
    return client;
};

// Confirms the given credentials/bucket are usable — throws if the bucket
// doesn't exist or the credentials can't access it.
const validateS3Credentials = async (config: IS3Config): Promise<void> => {
    const client = getS3Client(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));
};

const downloadFromS3 = async (
    config: IS3Config,
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

const DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS = 3600 * 24;

// Signs a time-limited URL the client downloads directly from S3 — for large/multi-part
// exports where proxying bytes through this server (buffered or streamed) doesn't scale:
// no server memory/CPU/connection is held for the transfer, S3 handles the throughput,
// and the client can fetch multiple part URLs in parallel with Range-based resume.
// Signing is a local HMAC computation, not a network call, so this resolves near-instantly
// regardless of the object's size.
const getPresignedDownloadUrl = async (
    config: IS3Config,
    key: string,
    expiresInSeconds: number = DEFAULT_PRESIGNED_URL_EXPIRY_SECONDS
): Promise<string> => {
    const client = getS3Client(config);
    const command = new GetObjectCommand({ Bucket: config.bucketName, Key: key });
    return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

const uploadToS3 = async (
    config: IS3Config,
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

// Returns all S3 object keys under a given prefix, sorted alphabetically.
// Paginates through all pages (each page capped at 1,000 keys by the S3 API).
const listS3Objects = async (
    config: IS3Config,
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
            if (obj.Key && !obj.Key.endsWith('/')) {
                keys.push(obj.Key);
            }
        }
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    return keys.sort();
};

// Same pagination as listS3Objects, but sums Size/counts objects instead of
// collecting keys — used for export CSV stats (count + total bytes under a
// prefix) without materializing every key name just to throw them away.
const getS3PrefixStats = async (
    config: IS3Config,
    prefix: string
): Promise<{ count: number; sizeInBytes: number }> => {
    const client = getS3Client(config);

    let count = 0;
    let sizeInBytes = 0;
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
            if (obj.Key && !obj.Key.endsWith('/')) {
                count += 1;
                sizeInBytes += obj.Size ?? 0;
            }
        }
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    return { count, sizeInBytes };
};

// Same pagination as listS3Objects, but keeps LastModified to filter by age —
// used for retention cleanup instead of a full listing + a HeadObject per key.
const listStaleS3Objects = async (
    config: IS3Config,
    prefix: string,
    olderThanMs: number
): Promise<string[]> => {
    const client = getS3Client(config);
    const cutoff = Date.now() - olderThanMs;

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
            if (obj.Key && obj.LastModified && obj.LastModified.getTime() < cutoff) {
                keys.push(obj.Key);
            }
        }
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    return keys;
};

// Deletes all keys listed in `keys` from the bucket, batched at 1,000 per request.
const deleteS3Objects = async (config: IS3Config, keys: string[]): Promise<void> => {
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

export {
    validateS3Credentials,
    downloadFromS3,
    getPresignedDownloadUrl,
    listS3Objects,
    getS3PrefixStats,
    uploadToS3,
    listStaleS3Objects,
    deleteS3Objects,
}
