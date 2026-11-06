import {
  AWS_ATHENA_ROLE_ARN,
  CLOUDFORMATION_TEMPLATE_URL,
  DATACRAFT_AWS_ACCOUNT_ID,
  PUBLIC_API_BASE_URL,
  S3_ROLE_SESSION_SECONDS,
} from '../../../constant';
import { S3_ASSUME_ROLE_CFN_TEMPLATE } from '../../../assets/cloudformation/s3-assumerole-role';
import { getAthenaBucketPolicyStatement } from '../athena';
import { createExternalId } from './credentials';

// Everything the "Connect to AWS" screen shows a customer so they can create their IAM role:
// DataCraft's account, a fresh External ID, and policy JSON / CloudFormation quick-create link.
// Also includes the Athena bucket-policy statement so restore preview / dry-run can read the bucket.

interface IRoleSetupInput {
  userId: string;
  bucketName: string;
  region?: string;
  folderPath?: string;
  kmsKeyArn?: string;
}

const KMS_KEY_ARN_PATTERN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{8,}$/;
const ATHENA_ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@\-_/]+$/;

const isValidKmsKeyArn = (arn: string | undefined): boolean => !!arn && KMS_KEY_ARN_PATTERN.test(arn);

const isRoleSetupConfigured = (): boolean => /^\d{12}$/.test(DATACRAFT_AWS_ACCOUNT_ID);

const resolveAthenaRoleArn = (): string | null =>
  ATHENA_ROLE_ARN_PATTERN.test(AWS_ATHENA_ROLE_ARN) ? AWS_ATHENA_ROLE_ARN : null;

// Customer-facing CFN session: always 1 hour (role chaining + refresh). Do not advertise 12h.
const CUSTOMER_MAX_SESSION_SECONDS = 3600;

const resolveTemplateUrl = (): string | null => {
  if (CLOUDFORMATION_TEMPLATE_URL) return CLOUDFORMATION_TEMPLATE_URL;
  if (!PUBLIC_API_BASE_URL) return null;
  return `${PUBLIC_API_BASE_URL}/v1/public/s3-assumerole-role.cfn.yaml`;
};

const buildCloudFormationQuickCreateUrl = (params: {
  region: string;
  dataCraftAccountId: string;
  externalId: string;
  bucketName: string;
  folderPath?: string;
  maxSessionSeconds: number;
  athenaRoleArn?: string | null;
}): string | null => {
  const templateUrl = resolveTemplateUrl();
  if (!templateUrl) return null;

  const region = params.region || 'us-east-1';
  const qs = new URLSearchParams({
    templateURL: templateUrl,
    stackName: 'DataCraftS3AccessRole',
    param_DataCraftAwsAccountId: params.dataCraftAccountId,
    param_ExternalId: params.externalId,
    param_BucketName: params.bucketName,
    param_RoleName: 'DataCraftS3AccessRole',
    param_MaxSessionDurationSeconds: String(params.maxSessionSeconds),
  });
  if (params.folderPath) {
    qs.set('param_FolderPrefix', params.folderPath.replace(/^\/+|\/+$/g, ''));
  }
  if (params.athenaRoleArn) {
    qs.set('param_DataCraftAthenaRoleArn', params.athenaRoleArn);
  }

  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks/quickcreate?${qs.toString()}`;
};

const buildCloudFormationTemplate = (params: {
  dataCraftAccountId: string;
  externalId: string;
  bucketName: string;
  folderPath?: string;
  maxSessionSeconds: number;
  athenaRoleArn?: string | null;
}): string => {
  const folder = params.folderPath ? params.folderPath.replace(/^\/+|\/+$/g, '') : '';
  const athenaArn = params.athenaRoleArn ?? '';
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  DataCraft S3 access role for keyless destination connect, plus a bucket
  policy so DataCraft Athena can run restore preview / dry-run queries.
  Customer deploys this in their AWS account. DataCraft assumes the role
  with ExternalId — no IAM user access keys required.
  Note: the Athena bucket policy resource sets the bucket's policy document
  for this stack. If the bucket already has a policy you need to keep,
  leave DataCraftAthenaRoleArn empty and merge the Athena statement from
  DataCraft Manual setup instead.

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
  DataCraftAthenaRoleArn:
    Type: String
    Default: '${athenaArn}'
    Description: DataCraft Athena role ARN for restore preview / dry-run

Conditions:
  HasFolderPrefix: !Not [!Equals [!Ref FolderPrefix, '']]
  HasAthenaRole: !Not [!Equals [!Ref DataCraftAthenaRoleArn, '']]

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

  DataCraftAthenaBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Condition: HasAthenaRole
    Properties:
      Bucket: !Ref BucketName
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Sid: DataCraftAthenaRoleAccess
            Effect: Allow
            Principal:
              AWS: !Ref DataCraftAthenaRoleArn
            Action:
              - s3:GetObject
              - s3:ListBucket
              - s3:GetBucketLocation
              - s3:PutObject
              - s3:ListBucketMultipartUploads
              - s3:ListMultipartUploadParts
              - s3:AbortMultipartUpload
            Resource:
              - !Sub 'arn:aws:s3:::\${BucketName}'
              - !Sub 'arn:aws:s3:::\${BucketName}/*'

Outputs:
  RoleArn:
    Description: Paste this Role ARN into DataCraft Connect to AWS
    Value: !GetAtt DataCraftS3AccessRole.Arn
`;
};

const buildRoleSetup = ({ userId, bucketName, region, folderPath, kmsKeyArn }: IRoleSetupInput) => {
  const externalId = createExternalId(userId);
  const bucketArn = `arn:aws:s3:::${bucketName}`;
  const prefix = folderPath ? `${folderPath.replace(/^\/+|\/+$/g, '')}/` : '';
  const athenaRoleArn = resolveAthenaRoleArn();

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

  const platformSessionSeconds = Math.max(3600, Math.min(43200, S3_ROLE_SESSION_SECONDS || 3600));
  const customerSessionSeconds = CUSTOMER_MAX_SESSION_SECONDS;

  // Pasted into the customer's bucket policy so Athena can query backups for restore preview / dry-run.
  const athenaBucketPolicyStatement = athenaRoleArn
    ? getAthenaBucketPolicyStatement(bucketName)
    : undefined;

  return {
    dataCraftAccountId: DATACRAFT_AWS_ACCOUNT_ID,
    externalId,
    requiredMaxSessionHours: Math.ceil(customerSessionSeconds / 3600),
    trustPolicy,
    permissionsPolicy,
    usesCustomerKmsKey: Boolean(kmsKeyArn),
    athenaRoleArn: athenaRoleArn ?? undefined,
    athenaBucketPolicyStatement,
    cloudFormationTemplate: buildCloudFormationTemplate({
      dataCraftAccountId: DATACRAFT_AWS_ACCOUNT_ID,
      externalId,
      bucketName,
      folderPath,
      maxSessionSeconds: customerSessionSeconds,
      athenaRoleArn,
    }),
    cloudFormationParameters: {
      DataCraftAwsAccountId: DATACRAFT_AWS_ACCOUNT_ID,
      ExternalId: externalId,
      BucketName: bucketName,
      RoleName: 'DataCraftS3AccessRole',
      MaxSessionDurationSeconds: customerSessionSeconds,
      ...(folderPath ? { FolderPrefix: folderPath.replace(/^\/+|\/+$/g, '') } : {}),
      ...(athenaRoleArn ? { DataCraftAthenaRoleArn: athenaRoleArn } : {}),
    },
    cloudFormationTemplateUrl: resolveTemplateUrl(),
    cloudFormationQuickCreateUrl: buildCloudFormationQuickCreateUrl({
      region: region || 'us-east-1',
      dataCraftAccountId: DATACRAFT_AWS_ACCOUNT_ID,
      externalId,
      bucketName,
      folderPath,
      maxSessionSeconds: customerSessionSeconds,
      athenaRoleArn,
    }),
    // Kept for debugging/support; not shown in wizard.
    platformSessionSeconds,
  };
};

export {
  buildRoleSetup,
  isRoleSetupConfigured,
  isValidKmsKeyArn,
  S3_ASSUME_ROLE_CFN_TEMPLATE,
};
