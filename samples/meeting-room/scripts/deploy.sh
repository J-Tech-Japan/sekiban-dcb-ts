#!/usr/bin/env bash
# Deploy the meeting-room sample through the composition helper.
# The Worker name and bindings stay in this sample's wrangler config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONFIG="$ROOT/samples/meeting-room/wrangler.cloudflare-only.jsonc"
CLI="$ROOT/packages/dcb-cloudflare/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  npm run build -w @sekiban/dcb-runtime --prefix "$ROOT"
  npm run build -w @sekiban/dcb-cloudflare --prefix "$ROOT"
fi

node "$CLI" deploy --config "$CONFIG" "$@"
