import {
    GetObjectCommand,
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
            if (obj.Key) {
                keys.push(obj.Key);
            }
        }
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    return keys.sort();
};

export {
    downloadFromS3,
    getPresignedDownloadUrl,
    listS3Objects,
    uploadToS3,
}
