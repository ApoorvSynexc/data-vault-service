# Execution Flow: Destination Creation

Step-by-step trace for creating an S3 destination.

## POST /v1/destination

### Middleware chain
```
authenticate → aclGateway → destinationValidation joi → createDestinationHandler
```

### Step 1: Validate request body (joi)

```typescript
// Required: name, provider ('AWS'), type ('S3'), config: { bucketName, region, accessKeyId, secretAccessKey, folderPath? }
```

### Step 2: Validate AWS credentials (optional early check)

```typescript
// validateS3Credentials(config) — attempts a cheap S3 operation to verify credentials
//   (utils/validate-aws-credentials.ts — the file is named "aws", the export is "S3")
// If fails: return 400 invalid_aws_credentials
```

### Step 3: Encrypt S3 config

```typescript
// client-service encryption: AES-256-CBC with per-tenant key (HKDF)
const { ciphertext, iv } = encryptForTenant(JSON.stringify({
  bucketName, region, accessKeyId, secretAccessKey, folderPath
}), user.userId);
// ciphertext prefixed with 'v2:' to mark per-tenant key
```

### Step 4: Generate slug + create record

```typescript
const slugCount = await incrementTableCounter(DESTINATION_TABLE, `slug:${toSlug(name)}`);
const slug = buildSlug(name, slugCount);

const destination = await createDestination({
  destinationId: uuid(),
  userId: user.userId,
  name, slug,
  provider,     // 'AWS'
  type,         // 'S3'
  ciphertext,
  iv,
  status: STATUS.active,
  spaceId: user.spaceId,
  createdAt, updatedAt,
});
```

### Step 5: Grant Athena role S3 access (fire-and-forget, non-fatal)

```typescript
// Fire-and-forget — destination creation succeeds even if this fails
grantAthenaRoleS3Access({ bucketName, region, accessKeyId, secretAccessKey }, user.userId)
  .catch(err => logger.error('Failed to grant Athena access:', err));
```

What `grantAthenaRoleS3Access` does:
```typescript
// 1. s3Client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
//    (uses CLIENT's credentials to modify THEIR bucket policy)
// 2. try GetBucketPolicy on bucketName
// 3. parse existing policy JSON (or start with empty policy)
// 4. check if SID 'AthenaDataVaultAccess' already present → if yes, skip
// 5. append statement:
//    { Sid: 'AthenaDataVaultAccess', Effect: 'Allow',
//      Principal: { AWS: ATHENA_ROLE_ARN },
//      Action: ['s3:GetObject', 's3:ListBucket'],
//      Resource: ['arn:aws:s3:::bucketName', 'arn:aws:s3:::bucketName/*'] }
// 6. PutBucketPolicy with merged policy
// 7. On failure: retry up to 3 times with 200ms×attempt delay
```

### Response

```typescript
return 201 { destination (ciphertext/iv redacted) }
```

## Destination Decryption (usage in backup-service)

When backup-service runs a job, it decrypts the destination:
```typescript
// job.destination = { type, ciphertext, iv, authTag }  (AES-256-GCM — backup-service encryption)
const destConfig = JSON.parse(decrypt({ ciphertext, iv, authTag }));
// destConfig = { bucketName, region, accessKeyId, secretAccessKey, folderPath }
```

Note: The backup-service re-encrypts the destination at job creation time using its own AES-256-GCM key (not the client-service AES-256-CBC per-tenant key). This is because backup-service stores the snapshot of credentials at job creation time — independent of future destination updates.

## GET /v1/destination

```typescript
// Queries DESTINATION_TABLE userId-index
// Returns list WITHOUT ciphertext/iv (credentials never returned in list)
// Optional: decrypt and include type/bucketName for display? (check controller)
```
