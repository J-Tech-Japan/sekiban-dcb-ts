#!/usr/bin/env bash
# Apply both remote D1 migrations for the Cloudflare-only meeting-room sample.
# Run from anywhere; resolves paths relative to this script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONFIG="$ROOT/samples/meeting-room/wrangler.cloudflare-only.jsonc"

export CI=true

echo "Applying pipeline D1 migrations (remote)…"
npx wrangler d1 migrations apply sekiban-dcb-meeting-room-cloudflare-pipeline \
  --config "$CONFIG" --remote

echo "Applying MV D1 migrations (remote)…"
npx wrangler d1 migrations apply sekiban-dcb-meeting-room-cloudflare-mv \
  --config "$CONFIG" --remote

echo "Both remote D1 migrations applied."
