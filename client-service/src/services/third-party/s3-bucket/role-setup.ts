import { DATACRAFT_AWS_ACCOUNT_ID, S3_ROLE_SESSION_SECONDS } from '../../../constant';
import { getAthenaBucketPolicyStatement } from '../athena';
import { createExternalId } from './credentials';

// Everything the "Connect to AWS" screen shows a customer so they can create their IAM role:
// DataCraft's account, a fresh External ID, and policy JSON they can paste straight into AWS.

interface IRoleSetupInput {
  userId: string;
  bucketName: string;
  folderPath?: string;
  // Only for buckets encrypted with the customer's OWN KMS key. The customer types it into the setup
  // screen; we put it into their permissions policy so they do not have to edit any text by hand.
  kmsKeyArn?: string;
}

// A KMS key ARN, e.g. arn:aws:kms:us-east-2:222233334444:key/1234abcd-12ab-34cd-56ef-1234567890ab
// (an alias such as alias/my-key is not accepted: IAM policies need the key's own ARN).
const KMS_KEY_ARN_PATTERN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{8,}$/;

const isValidKmsKeyArn = (arn: string | undefined): boolean => !!arn && KMS_KEY_ARN_PATTERN.test(arn);

// The setup guide is useless until DataCraft's own AWS account number is configured.
const isRoleSetupConfigured = (): boolean => /^\d{12}$/.test(DATACRAFT_AWS_ACCOUNT_ID);

const buildRoleSetup = ({ userId, bucketName, folderPath, kmsKeyArn }: IRoleSetupInput) => {
  const externalId = createExternalId(userId);
  const bucketArn = `arn:aws:s3:::${bucketName}`;
  const prefix = folderPath ? `${folderPath.replace(/^\/+|\/+$/g, '')}/` : '';

  // Who may use the role: DataCraft's AWS account, and only when it presents this External ID.
  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${DATACRAFT_AWS_ACCOUNT_ID}:root` },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': externalId } },
      },
    ],
  };

  // What the role may do: only this bucket. s3:GetBucketPolicy lets DataCraft verify the Athena
  // statement; it cannot change the policy.
  const permissionsPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DataCraftBucketAccess',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation', 's3:GetBucketPolicy', 's3:GetEncryptionConfiguration', 's3:ListBucketMultipartUploads'],
        Resource: bucketArn,
      },
      {
        Sid: 'DataCraftObjectAccess',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        Resource: `${bucketArn}/${prefix}*`,
      },
      // Added only when the customer gave us their own KMS key, so the one policy they copy is complete.
      ...(kmsKeyArn
        ? [
            {
              Sid: 'DataCraftKmsAccess',
              Effect: 'Allow',
              Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
              Resource: kmsKeyArn,
            },
          ]
        : []),
    ],
  };

  // Only needed when the bucket is encrypted with the customer's own KMS key (CMK).
  // The same role must ALSO be allowed in that key's own key policy.
  // const kmsStatementTemplate = {
  //   Sid: 'DataCraftKmsAccess',
  //   Effect: 'Allow',
  //   Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
  //   Resource: '<YOUR_KMS_KEY_ARN>',
  // };

  return {
    dataCraftAccountId: DATACRAFT_AWS_ACCOUNT_ID,
    externalId,
    // The customer must set the role's "Maximum session duration" to at least this many hours
    // (AWS defaults it to 1). Otherwise AWS refuses our request for a long pass.
    requiredMaxSessionHours: Math.ceil(S3_ROLE_SESSION_SECONDS / 3600),
    trustPolicy,
    permissionsPolicy,
    // kmsStatementTemplate,
    usesCustomerKmsKey: Boolean(kmsKeyArn),
    // Pasted by the customer into their bucket policy so Athena can search their backups.
    athenaBucketPolicyStatement: getAthenaBucketPolicyStatement(bucketName),
  };
};

export { buildRoleSetup, isRoleSetupConfigured, isValidKmsKeyArn };
