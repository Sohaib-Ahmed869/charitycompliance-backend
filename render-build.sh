#!/usr/bin/env bash
set -e

# Install Chrome dependencies
apt-get update && apt-get install -y \
  libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
  libgtk-3-0 libxshmfence1 fonts-liberation

npm install
npx puppeteer browsers install chrome
