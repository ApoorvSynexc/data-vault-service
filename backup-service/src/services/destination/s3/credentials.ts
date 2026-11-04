import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AWS_REGION, S3_ROLE_SESSION_SECONDS } from '../../../constant';
import { IAwsCredentialIdentity, IDestinationConfig } from '../../../models';

// ---------------------------------------------------------------------------
// How backup-service gets permission to use a customer's S3 bucket (same rules as client-service).
//
//  ACCESS_KEYS (legacy): the customer's access key + secret arrive in the config. We just use them.
//  ASSUME_ROLE         : the config carries the customer's role address + External ID. We ask AWS (STS)
//                        for a temporary pass for that role and renew it by ourselves, so a job that
//                        runs for many hours never holds an expired pass.
// ---------------------------------------------------------------------------

const ROLE_SESSION_NAME = 'datacraft-s3';
// Fetch a new pass this long before the old one expires.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

type RoleConfig = Pick<IDestinationConfig, 'roleArn' | 'externalId'>;
type CredentialsInput = Pick<
  IDestinationConfig,
  'authType' | 'roleArn' | 'externalId' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken'
>;

export const isRoleAuth = (config: Pick<IDestinationConfig, 'authType'>): boolean =>
  config.authType === 'ASSUME_ROLE';

// One remembered pass per role. Concurrent callers share the same in-flight request.
const passCache = new Map<
  string,
  { pass?: IAwsCredentialIdentity; inFlight?: Promise<IAwsCredentialIdentity> }
>();

const passIsFresh = (pass?: IAwsCredentialIdentity): pass is IAwsCredentialIdentity =>
  !!pass && !!pass.expiration && pass.expiration.getTime() - Date.now() > REFRESH_BEFORE_EXPIRY_MS;

const fetchRolePass = async (
  roleArn: string,
  externalId: string
): Promise<IAwsCredentialIdentity> => {
  const identity = await fromTemporaryCredentials({
    params: {
      RoleArn: roleArn,
      ExternalId: externalId,
      RoleSessionName: ROLE_SESSION_NAME,
      DurationSeconds: S3_ROLE_SESSION_SECONDS,
    },
    // STS is called from the platform's own region, not the customer's bucket region.
    clientConfig: { region: AWS_REGION },
  })();
  return {
    accessKeyId: identity.accessKeyId,
    secretAccessKey: identity.secretAccessKey,
    sessionToken: identity.sessionToken,
    expiration: identity.expiration,
  };
};

export const resolveRolePass = async (config: RoleConfig): Promise<IAwsCredentialIdentity> => {
  if (!config.roleArn || !config.externalId) {
    throw new Error('invalid_role_destination');
  }
  const key = `${config.roleArn}|${config.externalId}`;
  const entry = passCache.get(key) ?? {};
  if (passIsFresh(entry.pass)) {return entry.pass;}
  if (entry.inFlight) {return entry.inFlight;}

  const inFlight = fetchRolePass(config.roleArn, config.externalId).then(
    (pass) => {
      passCache.set(key, { pass });
      return pass;
    },
    (err) => {
      // Do not remember a failure; the next call tries again.
      passCache.delete(key);
      throw err;
    }
  );
  passCache.set(key, { ...entry, inFlight });
  return inFlight;
};

// What to give `new S3Client({ credentials })`. For a role this is a function the SDK calls when it
// needs a pass, so a long-lived client keeps working across passes; for keys it is the keys.
export const getAwsCredentials = (
  config: CredentialsInput
): IAwsCredentialIdentity | (() => Promise<IAwsCredentialIdentity>) => {
  if (isRoleAuth(config)) {return () => resolveRolePass(config);}
  return {
    accessKeyId: config.accessKeyId as string,
    secretAccessKey: config.secretAccessKey as string,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
};

// Used to cache one S3 client per distinct identity (a role and a key never share a client).
export const credentialIdentityKey = (config: CredentialsInput): string =>
  isRoleAuth(config) ? `role:${config.roleArn}:${config.externalId}` : `key:${config.accessKeyId}`;
