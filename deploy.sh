#!/bin/bash

set -e

echo "🚀 Starting backend deployment..."

# ===== CONFIG =====
EC2_USER="ubuntu"
EC2_IP="15.207.113.209"

LOCAL_PROJECT_DIR="."   # current folder
REMOTE_APP_DIR="/home/ubuntu/datavault/client_service"

APP_NAME="client-service"

# ==================

echo "📦 Installing dependencies (local)..."
npm install

echo "🏗️ Building TypeScript (local)..."
npm run build

echo "📤 Uploading project to EC2..."

# Create remote dir if not exists
ssh $EC2_USER@$EC2_IP "mkdir -p $REMOTE_APP_DIR"

# Upload only required files (no node_modules)
scp -r \
  dist \
  package.json \
  .env \
  $EC2_USER@$EC2_IP:$REMOTE_APP_DIR/

echo "⚙️ Running deployment on EC2..."

ssh $EC2_USER@$EC2_IP << EOF

cd $REMOTE_APP_DIR

echo "📥 Installing dependencies (server)..."
npm install

echo "🔁 Restarting app with PM2..."

pm2 describe $APP_NAME > /dev/null 2>&1

if [ \$? -eq 0 ]; then
    echo "♻️ Restarting existing app..."
    pm2 restart $APP_NAME
else
    echo "🆕 Starting new app..."
    pm2 start dist/index.js --name $APP_NAME
fi

pm2 save

echo "✅ Backend deployed successfully!"

EOF

echo "🎉 DONE: Backend is live!"