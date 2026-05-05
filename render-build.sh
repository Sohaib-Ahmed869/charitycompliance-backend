#!/usr/bin/env bash
set -e
apt-get update && apt-get install -y \
  libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
  libgtk-3-0 libxshmfence1 fonts-liberation

echo "=== Node & npm versions ==="
node -v
npm -v

echo "=== Running npm install ==="
npm install

echo "=== Checking saslprep installation ==="
ls -la node_modules/@mongodb-js/saslprep/ || echo "!!! saslprep DIR MISSING"
ls -la node_modules/@mongodb-js/saslprep/dist/ || echo "!!! saslprep/dist MISSING"
cat node_modules/@mongodb-js/saslprep/package.json 2>/dev/null | head -30 || echo "!!! no package.json"

echo "=== Force-reinstalling saslprep just in case ==="
npm install @mongodb-js/saslprep --save

ls -la node_modules/@mongodb-js/saslprep/dist/ || echo "!!! STILL missing after force install"

npx puppeteer browsers install chrome