# S3 AssumeRole destination — deploy & test (`feat/s3-assumerole-external-id`)

Branches (from `QA`):

- Backend: `DataVault-Backend-NodeJS` → `feat/s3-assumerole-external-id`
- Frontend: `DataVault-Frontend-App` → `feat/s3-assumerole-external-id`

Customer brings **S3 + IAM role only**. Connect wizard: region picker (no default), CloudFormation | Manual role setup, staged Test connection. Athena is **not** part of this wizard.

Long backups use **1-hour** STS sessions (`S3_ROLE_SESSION_SECONDS=3600`) with automatic refresh before expiry (required under ECS/EC2 role chaining).

---

## 1. Platform env (DEV EC2 client-service)

Add/update `/var/www/DataVault-Backend-NodeJS/client-service/.env`:

```bash
DATACRAFT_AWS_ACCOUNT_ID=394567804523
S3_ROLE_SESSION_SECONDS=3600
# optional; defaults to ENCRYPTION_KEY
EXTERNAL_ID_SECRET=<long-random-secret>
ALLOW_ACCESS_KEY_DESTINATIONS=true
```

Set the same `S3_ROLE_SESSION_SECONDS=3600` on the **ECS backup-service** task definition.

---

## 2. Platform IAM

### EC2 instance role + ECS backup task role

Allow:

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": "arn:aws:iam::*:role/DataCraftS3AccessRole*"
}
```

ECS task role DynamoDB resources must match the table prefix your `NODE_ENV` uses (e.g. `development-data-vault-*`).

---

## 3. Deploy code (DEV)

### Backend (EC2 client-service)

```bash
su - ubuntu   # or the user that owns PM2 client-service
cd /var/www/DataVault-Backend-NodeJS
git fetch origin
git checkout feat/s3-assumerole-external-id
git pull origin feat/s3-assumerole-external-id

cd client-service
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm run build
pm2 restart client-service --update-env
pm2 logs client-service --lines 50
```

### Backend (ECS backup-service)

```bash
# CloudShell — from backup-service/
git checkout feat/s3-assumerole-external-id && git pull
cd backup-service
# docker build --no-cache, tag with a unique tag or pin digest, push to DEV ECR
# Task definition: set image + S3_ROLE_SESSION_SECONDS=3600, new revision, force deploy
# Update BACKUP_SERVICE=http://<task-private-ip>:3001/api on EC2, pm2 restart
```

### Frontend

```bash
cd /var/www/DataVault-Frontend-App
git fetch origin
git checkout feat/s3-assumerole-external-id
git pull origin feat/s3-assumerole-external-id
npm ci && npm run build
# copy dist into client-service/client/dist (same as usual DEV deploy)
pm2 restart client-service
```

---

## 4. Connect wizard test

1. **Step 1:** Connection name + bucket + **Choose bucket region** (no default) → **Configure it**
2. Wrong region → accept **Use &lt;detected-region&gt;**; invalid bucket (`My Bucket`) → format error
3. **Step 2:** CloudFormation (download template) or Manual (copy policies) → **I've created the role**
4. Customer role max session ≥ **1 hour** (AWS default is enough)
5. **Step 3:** Paste Role ARN → **Test connection** (four checks) → **Connect**
6. Wrong role name → first check fails; remaining skipped
7. Run a backup → objects in customer bucket (session refresh keeps long jobs alive)

---

## 5. Promote

After DEV sign-off: PR `feat/s3-assumerole-external-id` → `QA` (backend + frontend), then QA → prod with the same env/IAM steps on each environment.
