// ---------------------------------------------------------------------------
// Turns the raw error from AWS into ONE clear reason, so the customer sees what to fix and the
// logs say what really happened.
//
// AWS errors are vague. "AccessDenied" can mean the role does not trust us, the role cannot use the
// bucket, or the role cannot use the bucket's encryption key. The message text is the only way to
// tell them apart, so we look at both the error name and the message.
//
// Each reason is also a key in assets/localization/en.json (the message the customer reads).
// ---------------------------------------------------------------------------

export type RoleConnectionReason =
  | 'role_max_session_too_short' // the role allows less than the 12 hours we ask for
  | 'role_chaining_limit' //        DataCraft's own setup caps passes at 1 hour (not the customer's fault)
  | 'role_trust_denied' //          AWS refused to let DataCraft become the role
  | 'bucket_not_found' //           the bucket name does not exist
  | 'bucket_region_mismatch' //     the bucket lives in a different region
  | 'role_kms_denied' //            the role cannot use the bucket's encryption key
  | 'role_s3_denied' //             the role was accepted but cannot use the bucket
  | 'role_connection_failed'; //    anything else

interface IAwsLikeError {
  name?: string;
  message?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

const text = (err: unknown): string => {
  const e = (err ?? {}) as IAwsLikeError;
  return `${e.name ?? ''} ${e.Code ?? ''} ${e.message ?? ''}`.toLowerCase();
};

const classifyRoleConnectionError = (err: unknown): RoleConnectionReason => {
  const e = (err ?? {}) as IAwsLikeError;
  const t = text(err);
  const status = e.$metadata?.httpStatusCode;

  // Raised by our own credentials helper when AWS refused the 12-hour request.
  if (e.message === 'role_max_session_too_short') {return 'role_max_session_too_short';}
  if (e.message === 'role_chaining_limit') {return 'role_chaining_limit';}

  // Step "become the role" (STS). Wrong role ARN, wrong External ID, or a trust policy that does not
  // name DataCraft's account all end up here.
  if (t.includes('sts:assumerole') || t.includes('assumerole') || t.includes('not authorized to perform: sts')) {
    return 'role_trust_denied';
  }

  // Step "use the bucket" (S3).
  if (t.includes('nosuchbucket') || (status === 404 && !t.includes('nosuchkey'))) {return 'bucket_not_found';}
  if (t.includes('permanentredirect') || t.includes('authorizationheadermalformed') || status === 301) {
    return 'bucket_region_mismatch';
  }
  if (t.includes('kms')) {return 'role_kms_denied';}
  if (t.includes('accessdenied') || t.includes('forbidden') || status === 403) {return 'role_s3_denied';}

  return 'role_connection_failed';
};

// One readable line for the logs: the reason we decided on, and the original AWS error.
const describeAwsError = (err: unknown): string => {
  const e = (err ?? {}) as IAwsLikeError;
  const status = e.$metadata?.httpStatusCode;
  return `${e.name ?? 'Error'}${status ? ` (HTTP ${status})` : ''}: ${e.message ?? String(err)}`;
};

export { classifyRoleConnectionError, describeAwsError };
