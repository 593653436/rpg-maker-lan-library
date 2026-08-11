#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
[ -f config.json ] || { echo 'Run npm run setup first.' >&2; exit 1; }
exec node server.mjs
