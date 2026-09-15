#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
npm run build --silent
exec ./node_modules/.bin/electron .
