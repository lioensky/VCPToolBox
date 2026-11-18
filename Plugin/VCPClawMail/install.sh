#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo "[VCPClawMail] Installing plugin-local dependencies..."
npm install
echo "[VCPClawMail] Done."