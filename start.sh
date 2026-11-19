#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Job Radar → http://127.0.0.1:${PORT:-7788}"
exec node server.mjs
