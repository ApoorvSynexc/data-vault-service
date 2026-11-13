import crypto from 'crypto';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AWS_REGION, EXTERNAL_ID_SECRET, S3_ROLE_SESSION_SECONDS } from '../../../constant';
import { IAwsCredentialIdentity, IS3Config } from '../../../models';
import { decrypt, type EncryptedPayload } from '../../../utils/encryption';
import { logger } from '../../../middlewares/logger';

// ---------------------------------------------------------------------------
// How DataCraft gets permission to use a customer's S3 bucket.
//
//  ACCESS_KEYS (legacy): the customer's own access key + secret are stored. We just use them.
//  ASSUME_ROLE         : the customer's AWS account trusts ours. We ask AWS (STS) for a temporary
//                        pass (default 1 hour under role chaining) for their role, and renew it
//                        before expiry. Nothing secret of the customer's is ever stored.
//
// Everything that needs S3 credentials should come through this file.
// ---------------------------------------------------------------------------

const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const ROLE_SESSION_NAME = 'datacraft-s3';
// Fetch a new pass this long before the old one expires, so a request never starts with a nearly-dead pass.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

const isRoleAuth = (config: Pick<IS3Config, 'authType'>): boolean => config.authType === 'ASSUME_ROLE';

const isValidRoleArn = (roleArn: string | undefined): boolean => !!roleArn && ROLE_ARN_PATTERN.test(roleArn);

// One remembered pass per role. Concurrent callers share the same in-flight request.
const passCache = new Map<string, { pass?: IAwsCredentialIdentity; inFlight?: Promise<IAwsCredentialIdentity> }>();

const passIsFresh = (
  pass: IAwsCredentialIdentity | undefined,
  minRemainingMs: number
): pass is IAwsCredentialIdentity =>
  !!pass && !!pass.expiration && pass.expiration.getTime() - Date.now() > minRemainingMs;

// AWS refuses a request for more time than the customer's role allows (their "Maximum session
// duration", 1 hour by default). That is the most common setup mistake, so it gets its own error.
//
// A second, different cause: when DataCraft itself runs on an assumed role (role chaining, e.g. SSO),
// AWS caps every pass at 1 hour whatever the customer set. The customer cannot fix that, so it must not
// be reported as their mistake. Its message also mentions DurationSeconds, so it is checked first.
const isRoleChainingLimitError = (err: unknown): boolean =>
  /role chaining/i.test(String((err as Error)?.message ?? ''));

const isSessionDurationError = (err: unknown): boolean => {
  const message = String((err as Error)?.message ?? '');
  return /DurationSeconds|MaxSessionDuration/i.test(message);
};

const fetchRolePass = async (roleArn: string, externalId: string): Promise<IAwsCredentialIdentity> => {
  const provider = fromTemporaryCredentials({
    params: {
      RoleArn: roleArn,
      ExternalId: externalId,
      RoleSessionName: ROLE_SESSION_NAME,
      DurationSeconds: S3_ROLE_SESSION_SECONDS,
    },
    // STS is called from the platform's own region, not the customer's bucket region.
    clientConfig: { region: AWS_REGION },
  });

  try {
    const identity = await provider();
    return {
      accessKeyId: identity.accessKeyId,
      secretAccessKey: identity.secretAccessKey,
      sessionToken: identity.sessionToken,
      expiration: identity.expiration,
    };
  } catch (err) {
    if (isRoleChainingLimitError(err)) {
      logger.error(
        `[s3-role] AWS limits passes to 1 hour because DataCraft itself runs on an assumed role (role chaining). Run the service on an ECS task role / EC2 instance role instead. roleArn=${roleArn}`
      );
      // eslint-disable-next-line preserve-caught-error -- tsconfig target has no Error cause
      throw new Error('role_chaining_limit');
    }
    if (isSessionDurationError(err)) {
      // eslint-disable-next-line preserve-caught-error -- tsconfig target has no Error cause
      throw new Error('role_max_session_too_short');
    }
    throw err;
  }
};

const resolveRolePass = async (
  config: Pick<IS3Config, 'roleArn' | 'externalId'>,
  minRemainingMs: number = REFRESH_BEFORE_EXPIRY_MS
): Promise<IAwsCredentialIdentity> => {
  if (!isValidRoleArn(config.roleArn) || !config.externalId) {
    throw new Error('invalid_role_destination');
  }
  const key = `${config.roleArn}|${config.externalId}`;
  const entry = passCache.get(key) ?? {};
  if (passIsFresh(entry.pass, minRemainingMs)) {return entry.pass;}
  // Share a request already on its way, unless this caller needs a longer-lived pass than the
  // ordinary refresh gives (Spark): a normal refresh may not satisfy it.
  if (entry.inFlight && minRemainingMs <= REFRESH_BEFORE_EXPIRY_MS) {return entry.inFlight;}

  const inFlight = fetchRolePass(config.roleArn!, config.externalId).then(
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
// needs a pass, so a long-lived client keeps working across passes; for legacy keys it is the keys.
const getAwsCredentials = (config: IS3Config): IAwsCredentialIdentity | (() => Promise<IAwsCredentialIdentity>) => {
  if (isRoleAuth(config)) {return () => resolveRolePass(config);}
  return {
    accessKeyId: config.accessKeyId as string,
    secretAccessKey: config.secretAccessKey as string,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
};

// What the Spark job receives. Spark assumes the customer role itself and renews the pass
// about five minutes before each one-hour expiry, so this must not mint a token: a token
// created here dies while a large compression is still sorting. Legacy keys pass through
// unchanged because they do not expire.
const resolveS3Config = <T extends IS3Config>(config: T): T => {
  if (!isRoleAuth(config)) {return config;}
  if (!isValidRoleArn(config.roleArn) || !config.externalId) {
    throw new Error('invalid_role_destination');
  }
  const {
    accessKeyId: _accessKeyId,
    secretAccessKey: _secretAccessKey,
    sessionToken: _sessionToken,
    ...rest
  } = config;
  return {
    ...rest,
    authType: 'ASSUME_ROLE',
    roleArn: config.roleArn,
    externalId: config.externalId,
  } as T;
};

// A restore job stores its source credentials in `source.encryptedKeys`. For a role destination it
// stores only the role address (never a pass, because a pass saved at creation time could expire
// before a scheduled restore starts). Whoever runs the job calls this to get credentials that work now.
type IStoredSourceKeys = {
  authType?: string;
  roleArn?: string;
  externalId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

const resolveStoredSourceKeys = async (
  encryptedKeys: EncryptedPayload | IStoredSourceKeys
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> => {
  const stored: IStoredSourceKeys =
    'cipherText' in encryptedKeys ? JSON.parse(decrypt(encryptedKeys as EncryptedPayload)) : encryptedKeys;

  if (stored.authType === 'ASSUME_ROLE') {
    const pass = await resolveRolePass(stored);
    return { accessKeyId: pass.accessKeyId, secretAccessKey: pass.secretAccessKey, sessionToken: pass.sessionToken };
  }
  return {
    accessKeyId: stored.accessKeyId as string,
    secretAccessKey: stored.secretAccessKey as string,
    ...(stored.sessionToken ? { sessionToken: stored.sessionToken } : {}),
  };
};

// Used to cache one S3 client per distinct identity (so a role and a key never share a client).
const credentialIdentityKey = (config: IS3Config): string =>
  isRoleAuth(config) ? `role:${config.roleArn}:${config.externalId}` : `key:${config.accessKeyId}`;

// ---------------------------------------------------------------------------
// External ID
// The customer pastes this into their role's trust policy. AWS only lets us assume the role when we
// present the same value, which stops one customer's role from being used by someone else's request
// (the "confused deputy" problem). The ID is derived from the user, so it can later be proven to have
// been issued to this user.
//
// The ID is STABLE: a user is always given the same one, so the customer pastes it into their role once
// and never has to touch the trust policy again. Nothing is stored; it is recomputed on demand.
//   current format : dc-v<version>-<stamp>          stamp = HMAC(secret, "<userId>:v<version>")
//   legacy format  : dc-<random 16 hex>-<stamp>     issued before IDs became stable; still accepted so
//                                                   destinations created with one keep working
// To rotate, raise EXTERNAL_ID_VERSION. Older versions stay valid (the customer can list both IDs in
// their trust policy while moving over), so a rotation never breaks an existing connection.
// ---------------------------------------------------------------------------
const EXTERNAL_ID_VERSION = 1;

const stamp = (userId: string, label: string): string =>
  crypto.createHmac('sha256', EXTERNAL_ID_SECRET).update(`${userId}:${label}`).digest('hex').slice(0, 16);

const stampMatches = (userId: string, label: string, actualStamp: string): boolean => {
  const expected = Buffer.from(stamp(userId, label));
  const actual = Buffer.from(actualStamp);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

const createExternalId = (userId: string): string => {
  const label = `v${EXTERNAL_ID_VERSION}`;
  return `dc-${label}-${stamp(userId, label)}`;
};

const isExternalIdIssuedTo = (userId: string, externalId: string | undefined): boolean => {
  const id = externalId ?? '';
  const current = /^dc-(v\d+)-([0-9a-f]{16})$/.exec(id);
  if (current) {return stampMatches(userId, current[1], current[2]);}
  const legacy = /^dc-([0-9a-f]{16})-([0-9a-f]{16})$/.exec(id);
  return !!legacy && stampMatches(userId, legacy[1], legacy[2]);
};

export {
  isRoleAuth,
  isValidRoleArn,
  resolveRolePass,
  getAwsCredentials,
  resolveS3Config,
  resolveStoredSourceKeys,
  credentialIdentityKey,
  createExternalId,
  isExternalIdIssuedTo,
};
