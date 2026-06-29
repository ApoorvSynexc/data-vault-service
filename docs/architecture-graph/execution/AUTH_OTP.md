# Execution Flow: Authentication (OTP)

Step-by-step trace for email/mobile OTP-based signup and login.

## Signup Flow

### Step 1: POST /v1/auth/signup

```typescript
// Joi validation: signupValidation
// body: { email, password, firstName, lastName, ... }

const existingUser = await getUser({ email });
if (existingUser) return 409 email_already_exists;

const hashedPassword = await bcrypt.hash(password, 10);
const userId = uuid();

await createUser({
  userId,
  contactEmail: email,
  password: hashedPassword,
  status: STATUS.inactive, // not yet verified
  authProvider: AUTH_PROVIDER.email,
  role: { roleId: defaultRoleId, name: 'Admin' },
  createdAt, updatedAt,
});

// Generate and send OTP
const otp = randomNumber(6); // 6-digit
await createOtp({ userId, code: otp, type: 'SIGNUP', channel: 'EMAIL', status: 'PENDING', ttl: now+15min });
// Send OTP via email (email service call — not in scope of this codebase)

return 200 { message: 'otp_sent' }
```

### Step 2: POST /v1/auth/verify-otp

```typescript
// body: { email, otp, type: 'SIGNUP' }

const user = await getUser({ email });
const otpRecord = await getOtp({ userId: user.userId, type: 'SIGNUP', status: 'PENDING' });
if (!otpRecord || otpRecord.code !== otp) return 400 invalid_otp;
if (otpRecord.ttl < now) return 400 otp_expired;

await updateOtp(otpRecord.id, { status: 'VERIFIED' });
await updateUser({ userId: user.userId }, { status: STATUS.active });

// Create session
const session = await createSession({
  sessionId: uuid(),
  userId: user.userId,
  status: SESSION_STATUS.active,
  ttl: now + parseExpiryToSeconds(JWT_REFRESH_EXPIRY), // 7d
  deviceInfo: { userAgent, ipAddress },
});

const { accessToken, refreshToken } = generateTokens(user.userId, session.sessionId);

// Set httpOnly cookies
res.cookie('accessToken', accessToken, { httpOnly: true, secure: true, sameSite: 'strict' });
res.cookie('refreshToken', refreshToken, { httpOnly: true, secure: true, sameSite: 'strict' });

return 200 { user (without password) }
```

## Login Flow

### Step 1: POST /v1/auth/login

```typescript
// body: { email, password }

const user = await getUser({ email });
if (!user) return 400 user_not_found;
if (user.status === STATUS.deleted) return 400 account_deleted;

const isMatch = await bcrypt.compare(password, user.password);
if (!isMatch) return 400 password_not_match;

// If user is inactive (not verified yet), resend OTP
if (user.status === STATUS.inactive) {
  // createOtp and send email
  return 200 { message: 'otp_required' }
}

// Active user: create session and return tokens
const session = await createSession({ ... });
const tokens = generateTokens(user.userId, session.sessionId);
// Set cookies
return 200 { user }
```

## Logout

### GET /v1/user/logout (requires authenticate middleware)

```typescript
const session = await getSession(req.sessionId);
if (!session || session.status !== SESSION_STATUS.active) return 401;

await updateSession(session.sessionId, { status: SESSION_STATUS.revoked });
// Cookie cleared by client (or set to empty)
return 200 { message: 'logout' }
```

## Token Refresh

### POST /v1/auth/refresh-token

```typescript
const refreshToken = req.cookies.refreshToken;
const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

const session = await getSession(payload.sessionId);
if (!session || session.status !== SESSION_STATUS.active) return 401;

const user = await getUser({ userId: payload.userId });
if (!user) return 401;

// Issue new access token only (refresh token unchanged)
const newAccessToken = jwt.sign({ userId, sessionId }, JWT_ACCESS_SECRET, { expiresIn: JWT_ACCESS_EXPIRY });
res.cookie('accessToken', newAccessToken, { httpOnly: true });
return 200 { message: 'refreshed' }
```

## Password Reset

### POST /v1/auth/forgot-password → POST /v1/auth/reset-password

```typescript
// forgot-password:
const user = await getUser({ email });
const otp = randomNumber(6);
await createOtp({ userId, type: 'RESET_PASSWORD', status: 'PENDING', ttl: ... });
// Send email

// reset-password (body: { email, otp, newPassword }):
// Verify OTP → updateOtp VERIFIED → bcrypt.hash → updateUser password
```

## Session Lifecycle

```
createSession (on login/signup)
  ↓ status: ACTIVE
  ↓ ttl: now + JWT_REFRESH_EXPIRY seconds (e.g. 7 days)
  
authenticate middleware (on every request)
  ↓ verify accessToken → extract sessionId
  ↓ getSession(sessionId) → must be ACTIVE
  ↓ getUser(userId) → must exist, not inactive

logout
  ↓ updateSession: status = REVOKED
  ↓ next authenticate attempt → 401 (session not ACTIVE)

DynamoDB TTL
  ↓ session.ttl expires after 7 days
  ↓ DynamoDB auto-deletes the item
  ↓ next authenticate → session not found → 401
```
