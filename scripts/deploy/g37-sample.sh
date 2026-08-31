#!/usr/bin/env bash
set -euo pipefail

# One lightweight SDT-G37 sample. This deliberately has no G30-style
# A/B/A-prime phases, cohort deadline, or delivery-budget gate. The optional
# observability token enables the exact provider-side trace join; without it,
# the client window still runs and records AC4 per-hop as UNKNOWN.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly CONFIG="samples/meeting-room/wrangler.g37-primary.jsonc"
readonly WORKER="sekiban-dcb-meeting-room-cloudflare-only"
readonly SERVICE_ID="g32-9043d626fe1149cb"
readonly BASE_URL="${G37_BASE_URL:-https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev}"
readonly SOURCE_COMMIT="${G37_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly CANDIDATE="${G37_CANDIDATE:?G37_CANDIDATE is required}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
readonly OBSERVABILITY_TOKEN_FILE="${G37_OBSERVABILITY_TOKEN_FILE:-${G30_OBSERVABILITY_TOKEN_FILE:-}}"
readonly SAMPLES="${G37_SAMPLES:-50}"
readonly PROFILE="${G37_PROFILE:-single}"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
[[ "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]
[[ -z "$(git status --porcelain --untracked-files=no)" ]]

mkdir -p .artifacts
readonly PREFIX=".artifacts/g37-${CANDIDATE//[^a-zA-Z0-9._-]/-}-${SOURCE_COMMIT:0:12}"
readonly BEFORE_VERSIONS="${PREFIX}-versions-before.json"
readonly AFTER_VERSIONS="${PREFIX}-versions-after.json"
readonly OUTPUT="${PREFIX}.json"
readonly MESSAGE="SDT-G37 ${CANDIDATE} ${SERVICE_ID} ${SOURCE_COMMIT}"

# The primary config preserves the currently deployed G32 receiver binding
# plus persisted trace/log collection. G38's separately owned new receiver
# Worker is not yet live, so G37 neither creates it nor retargets to it.
"${WRANGLER_BIN}" deploy --config "${CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${SERVICE_ID}"
"${WRANGLER_BIN}" versions list --name "${WORKER}" --json > "${BEFORE_VERSIONS}"

TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g37-conformance.XXXXXX")"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g37-secrets.XXXXXX")"
chmod 600 "${TOKEN_FILE}" "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${SECRETS_FILE}"' EXIT
openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
node -e 'const fs=require("fs");const token=fs.readFileSync(process.argv[1],"utf8").trim();if(!token)throw new Error("empty G37 conformance token");fs.writeFileSync(process.argv[2],JSON.stringify({CONFORMANCE_TOKEN:token})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${SECRETS_FILE}"

"${WRANGLER_BIN}" deploy --config "${CONFIG}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" --var "SDT_SERVICE_ID:${SERVICE_ID}" --message "${MESSAGE}"
"${WRANGLER_BIN}" versions list --name "${WORKER}" --json > "${AFTER_VERSIONS}"

node "${SCRIPT_DIR}/g37-sample.mjs" \
  --base-url "${BASE_URL}" \
  --token-file "${TOKEN_FILE}" \
  --account-id "${ACCOUNT_ID}" \
  --observability-token-file "${OBSERVABILITY_TOKEN_FILE}" \
  --profile "${PROFILE}" \
  --candidate "${CANDIDATE}" \
  --source-commit "${SOURCE_COMMIT}" \
  --samples "${SAMPLES}" \
  --prior-versions "${BEFORE_VERSIONS}" \
  --versions "${AFTER_VERSIONS}" \
  --deployment-message "${MESSAGE}" \
  --output "${OUTPUT}"

printf 'G37 lightweight sample complete: %s\n' "${OUTPUT}"
