import { DATACRAFT_AWS_ACCOUNT_ID, S3_ROLE_SESSION_SECONDS } from '../../../constant';
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

const buildCloudFormationTemplate = (params: {
  dataCraftAccountId: string;
  externalId: string;
  bucketName: string;
  folderPath?: string;
  maxSessionSeconds: number;
}): string => {
  const folder = params.folderPath ? params.folderPath.replace(/^\/+|\/+$/g, '') : '';
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  DataCraft S3 access role for keyless destination connect.
  Customer deploys this in their AWS account. DataCraft assumes the role
  with ExternalId — no IAM user access keys required.

Parameters:
  DataCraftAwsAccountId:
    Type: String
    Default: '${params.dataCraftAccountId}'
  ExternalId:
    Type: String
    Default: '${params.externalId}'
  BucketName:
    Type: String
    Default: '${params.bucketName}'
  RoleName:
    Type: String
    Default: DataCraftS3AccessRole
  MaxSessionDurationSeconds:
    Type: Number
    Default: ${params.maxSessionSeconds}
  FolderPrefix:
    Type: String
    Default: '${folder}'

Conditions:
  HasFolderPrefix: !Not [!Equals [!Ref FolderPrefix, '']]

Resources:
  DataCraftS3AccessRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Ref RoleName
      MaxSessionDuration: !Ref MaxSessionDurationSeconds
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::\${DataCraftAwsAccountId}:root'
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: !Ref ExternalId
      Policies:
        - PolicyName: DataCraftS3BucketAccess
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: DataCraftBucketAccess
                Effect: Allow
                Action:
                  - s3:ListBucket
                  - s3:GetBucketLocation
                  - s3:GetBucketPolicy
                  - s3:GetEncryptionConfiguration
                  - s3:ListBucketMultipartUploads
                Resource: !Sub 'arn:aws:s3:::\${BucketName}'
              - Sid: DataCraftObjectAccess
                Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:DeleteObject
                  - s3:AbortMultipartUpload
                  - s3:ListMultipartUploadParts
                Resource: !If
                  - HasFolderPrefix
                  - !Sub 'arn:aws:s3:::\${BucketName}/\${FolderPrefix}*'
                  - !Sub 'arn:aws:s3:::\${BucketName}/*'

Outputs:
  RoleArn:
    Description: Paste this Role ARN into DataCraft Connect to AWS
    Value: !GetAtt DataCraftS3AccessRole.Arn
`;
};

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

  // What the role may do: only this bucket.
  const permissionsPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DataCraftBucketAccess',
        Effect: 'Allow',
        Action: [
          's3:ListBucket',
          's3:GetBucketLocation',
          's3:GetBucketPolicy',
          's3:GetEncryptionConfiguration',
          's3:ListBucketMultipartUploads',
        ],
        Resource: bucketArn,
      },
      {
        Sid: 'DataCraftObjectAccess',
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        Resource: `${bucketArn}/${prefix}*`,
      },
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

  const maxSessionSeconds = Math.max(3600, Math.min(43200, S3_ROLE_SESSION_SECONDS || 3600));

  return {
    dataCraftAccountId: DATACRAFT_AWS_ACCOUNT_ID,
    externalId,
    // Informational only — UI no longer instructs customers to raise session duration above 1 hour.
    requiredMaxSessionHours: Math.ceil(maxSessionSeconds / 3600),
    trustPolicy,
    permissionsPolicy,
    usesCustomerKmsKey: Boolean(kmsKeyArn),
    cloudFormationTemplate: buildCloudFormationTemplate({
      dataCraftAccountId: DATACRAFT_AWS_ACCOUNT_ID,
      externalId,
      bucketName,
      folderPath,
      maxSessionSeconds,
    }),
    cloudFormationParameters: {
      DataCraftAwsAccountId: DATACRAFT_AWS_ACCOUNT_ID,
      ExternalId: externalId,
      BucketName: bucketName,
      RoleName: 'DataCraftS3AccessRole',
      MaxSessionDurationSeconds: maxSessionSeconds,
      ...(folderPath ? { FolderPrefix: folderPath.replace(/^\/+|\/+$/g, '') } : {}),
    },
  };
};

export { buildRoleSetup, isRoleSetupConfigured, isValidKmsKeyArn };
