#!/usr/bin/env bash
set -e

echo "=== Git commit Render is building ==="
git log -1 --oneline 2>/dev/null || echo "no git"

echo "=== Does deployed package.json include saslprep? ==="
grep saslprep package.json || echo "!!! NOT IN package.json"

echo "=== Does package-lock.json include saslprep? ==="
grep -c saslprep package-lock.json || echo "!!! NOT IN package-lock.json"

echo "=== Any .npmrc? ==="
cat .npmrc 2>/dev/null || echo "(none)"
cat ~/.npmrc 2>/dev/null || echo "(no home .npmrc)"

apt-get update && apt-get install -y \
  libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
  libgtk-3-0 libxshmfence1 fonts-liberation

echo "=== Cleaning node_modules ==="
rm -rf node_modules

echo "=== Node & npm ==="
node -v
npm -v

echo "=== Running npm install --include=optional ==="
npm install --include=optional

echo "=== Checking saslprep AFTER install ==="
ls -la node_modules/@mongodb-js/ || echo "!!! @mongodb-js dir missing"
ls -la node_modules/@mongodb-js/saslprep/ || echo "!!! saslprep dir missing"
ls -la node_modules/@mongodb-js/saslprep/dist/ || echo "!!! saslprep/dist missing"

npx puppeteer browsers install chrome

echo "=== Final check before exit ==="
ls -la node_modules/@mongodb-js/saslprep/dist/ || echo "!!! GONE after puppeteer step"