import crypto from 'crypto';
import {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadBucketCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IAwsCredentials, IS3Config } from '../../../models';
import {
    credentialIdentityKey,
    getAwsCredentials,
    isRoleAuth,
    resolveRolePass,
} from './credentials';
import { classifyRoleConnectionError, describeAwsError } from './errors';
import { logger } from '../../../middlewares/logger';

export type ConnectionCheckId = 'assume_role' | 'bucket_access' | 'write_object' | 'read_object';
export type ConnectionCheckStatus = 'passed' | 'failed' | 'skipped';
export type ConnectionCheckResult = {
    id: ConnectionCheckId;
    status: ConnectionCheckStatus;
    reason?: string;
};

export type StagedConnectionTestResult = {
    connected: boolean;
    checks: ConnectionCheckResult[];
    failureReason?: string;
};

// ---------------------------------------------------------------------------
// One S3Client per unique destination (region + identity + bucket).
// Reusing the client lets the AWS SDK pool HTTP connections across calls
// instead of opening a new TLS handshake on every upload/download/list.
// For a role destination the client holds a credentials function, so it keeps
// working across temporary passes without being rebuilt.
// ---------------------------------------------------------------------------
const clientCache = new Map<string, S3Client>();
const getS3Client = (config: IS3Config): S3Client => {
    const cacheKey = `${config.region}:${credentialIdentityKey(config)}:${config.bucketName}`;
    let client = clientCache.get(cacheKey);
    if (!client) {
        const awsConfig: IAwsCredentials = {
            region: config.region,
            credentials: getAwsCredentials(config),
        };

        client = new S3Client(awsConfig as unknown as S3ClientConfig);
        clientCache.set(cacheKey, client);
    }
    return client;
};

// Confirms the given credentials/bucket are usable — throws if the bucket
// doesn't exist or the credentials can't access it.
// For a role destination this also writes, reads and deletes a tiny test file, so a missing
// write permission or a missing encryption-key (KMS) permission is caught now, not on the first backup.
const validateS3Credentials = async (config: IS3Config): Promise<void> => {
    const client = getS3Client(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));

    if (!isRoleAuth(config)) return;

    const prefix = config.folderPath ? `${config.folderPath.replace(/\/+$/, '')}/` : '';
    const key = `${prefix}.datacraft-connection-test/${crypto.randomUUID()}.txt`;
    await client.send(new PutObjectCommand({ Bucket: config.bucketName, Key: key, Body: 'datacraft connection test' }));
    try {
        await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
    } finally {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
    }
};

const CHECK_ORDER: ConnectionCheckId[] = ['assume_role', 'bucket_access', 'write_object', 'read_object'];

const skippedRemaining = (fromId: ConnectionCheckId): ConnectionCheckResult[] => {
    const start = CHECK_ORDER.indexOf(fromId);
    return CHECK_ORDER.slice(start + 1).map((id) => ({ id, status: 'skipped' as const }));
};

// Wizard "Test connection": run the four checks in order and stop on the first failure.
const runStagedRoleConnectionTest = async (
    config: IS3Config,
    userId?: string
): Promise<StagedConnectionTestResult> => {
    const checks: ConnectionCheckResult[] = [];

    try {
        await resolveRolePass(config);
        checks.push({ id: 'assume_role', status: 'passed' });
    } catch (err) {
        const reason = classifyRoleConnectionError(err);
        logger.warn(
            `[destination] staged check assume_role failed | reason:${reason} userId:${userId} bucket:${config.bucketName} roleArn:${config.roleArn} aws:${describeAwsError(err)}`
        );
        checks.push({ id: 'assume_role', status: 'failed', reason });
        return {
            connected: false,
            failureReason: reason,
            checks: [...checks, ...skippedRemaining('assume_role')],
        };
    }

    const client = getS3Client(config);
    const prefix = config.folderPath ? `${config.folderPath.replace(/\/+$/, '')}/` : '';
    const key = `${prefix}.datacraft-connection-test/${crypto.randomUUID()}.txt`;

    try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));
        checks.push({ id: 'bucket_access', status: 'passed' });
    } catch (err) {
        const reason = classifyRoleConnectionError(err);
        logger.warn(
            `[destination] staged check bucket_access failed | reason:${reason} userId:${userId} bucket:${config.bucketName} aws:${describeAwsError(err)}`
        );
        checks.push({ id: 'bucket_access', status: 'failed', reason });
        return {
            connected: false,
            failureReason: reason,
            checks: [...checks, ...skippedRemaining('bucket_access')],
        };
    }

    try {
        await client.send(
            new PutObjectCommand({ Bucket: config.bucketName, Key: key, Body: 'datacraft connection test' })
        );
        checks.push({ id: 'write_object', status: 'passed' });
    } catch (err) {
        const reason = classifyRoleConnectionError(err);
        logger.warn(
            `[destination] staged check write_object failed | reason:${reason} userId:${userId} bucket:${config.bucketName} aws:${describeAwsError(err)}`
        );
        checks.push({ id: 'write_object', status: 'failed', reason });
        return {
            connected: false,
            failureReason: reason,
            checks: [...checks, ...skippedRemaining('write_object')],
        };
    }

    try {
        await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
        checks.push({ id: 'read_object', status: 'passed' });
    } catch (err) {
        const reason = classifyRoleConnectionError(err);
        logger.warn(
            `[destination] staged check read_object failed | reason:${reason} userId:${userId} bucket:${config.bucketName} aws:${describeAwsError(err)}`
        );
        checks.push({ id: 'read_object', status: 'failed', reason });
        return { connected: false, failureReason: reason, checks };
    } finally {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key })).catch(() => undefined);
    }

    return { connected: true, checks };
};

// Discover the bucket's home region without customer credentials.
// Anonymous HEAD typically returns 301/403 with x-amz-bucket-region.
const extractRegionFromHeaders = (headers: Headers): string | null => {
    const direct = headers.get('x-amz-bucket-region') || headers.get('x-amz-region');
    if (direct) return direct.trim();
    return null;
};

const extractRegionFromBody = (body: string): string | null => {
    const regionMatch =
        /<Region>([a-z0-9-]+)<\/Region>/i.exec(body) ||
        /the region '([a-z0-9-]+)' is wrong/i.exec(body) ||
        /explicitly set region to ['"]([a-z0-9-]+)['"]/i.exec(body);
    return regionMatch?.[1] ?? null;
};

const probeBucketRegion = async (bucketName: string, endpoint: string): Promise<string | null> => {
    try {
        const res = await fetch(endpoint, { method: 'HEAD', redirect: 'manual' });
        const fromHeaders = extractRegionFromHeaders(res.headers);
        if (fromHeaders) return fromHeaders;

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location') || '';
            const locRegion = /\.s3[.-]([a-z0-9-]+)\.amazonaws\.com/i.exec(location);
            if (locRegion?.[1] && locRegion[1] !== 'dualstack') return locRegion[1];
        }

        // Some paths only put the region in a GET error body.
        if (res.status === 400 || res.status === 403 || res.status === 301 || res.status === 307) {
            const getRes = await fetch(endpoint, { method: 'GET', redirect: 'manual' });
            const fromGetHeaders = extractRegionFromHeaders(getRes.headers);
            if (fromGetHeaders) return fromGetHeaders;
            const body = await getRes.text().catch(() => '');
            return extractRegionFromBody(body);
        }
    } catch {
        return null;
    }
    return null;
};

const resolveBucketRegion = async (
    bucketName: string,
    claimedRegion?: string
): Promise<{ region: string; matchesClaimed: boolean; claimedRegion?: string }> => {
    const endpoints = [
        `https://${bucketName}.s3.amazonaws.com`,
        ...(claimedRegion ? [`https://${bucketName}.s3.${claimedRegion}.amazonaws.com`] : []),
        `https://${bucketName}.s3.us-east-1.amazonaws.com`,
    ];

    let detected: string | null = null;
    for (const endpoint of endpoints) {
        detected = await probeBucketRegion(bucketName, endpoint);
        if (detected) break;
    }

    if (!detected) {
        const err = new Error('bucket_region_unresolved');
        (err as Error & { code?: string }).code = 'bucket_region_unresolved';
        throw err;
    }

    const claimed = claimedRegion?.trim() || undefined;
    return {
        region: detected,
        claimedRegion: claimed,
        matchesClaimed: !claimed || claimed === detected,
    };
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
    runStagedRoleConnectionTest,
    resolveBucketRegion,
    downloadFromS3,
    getPresignedDownloadUrl,
    listS3Objects,
    getS3PrefixStats,
    uploadToS3,
    listStaleS3Objects,
    deleteS3Objects,
};
