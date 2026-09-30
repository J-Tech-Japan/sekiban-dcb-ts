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
readonly D1_DATABASE="sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline"
readonly D1_MV_DATABASE="sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv"
readonly D1_BASELINE_MIGRATION="${REPO_ROOT}/migrations/d1/g32/0001_dcb_events.sql"
readonly D1_COMPLETENESS_MIGRATION="${REPO_ROOT}/migrations/d1/g32/0002_g44_global_completeness.sql"
readonly SERVICE_ID="${SDT_SERVICE_ID:?SDT_SERVICE_ID is required}"
readonly BASE_URL="${G37_BASE_URL:-https://example.workers.dev}"
readonly SOURCE_COMMIT="${G37_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly CANDIDATE="${G37_CANDIDATE:?G37_CANDIDATE is required}"
readonly OBSERVABILITY_TOKEN_FILE="${G37_OBSERVABILITY_TOKEN_FILE:-${G30_OBSERVABILITY_TOKEN_FILE:-}}"
readonly SAMPLES="${G37_SAMPLES:-50}"
readonly PROFILE="${G37_PROFILE:-single}"
readonly DEPLOY_SETTLE_SECONDS="${G37_DEPLOY_SETTLE_SECONDS:-5}"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
[[ "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]
[[ -z "$(git status --porcelain --untracked-files=no)" ]]
if [[ "${PROFILE}" != "single" && "${PROFILE}" != "history-length" ]]; then
  printf 'G37_PROFILE must be single or history-length\n' >&2
  exit 2
fi
if [[ ! "${DEPLOY_SETTLE_SECONDS}" =~ ^[0-9]+$ ]]; then
  printf 'G37_DEPLOY_SETTLE_SECONDS must be a non-negative integer\n' >&2
  exit 2
fi

# Keep the account selection tied to the authenticated Wrangler session. Do not
# accept a stale hand-set account ID when whoami reports a different account.
readonly WHOAMI_JSON="$(WRANGLER_WRITE_LOGS=false "${WRANGLER_BIN}" whoami --json)"
readonly ACCOUNT_ID="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(0,"utf8"));const id=value.accounts?.[0]?.id;if(!/^[0-9a-f]{32}$/.test(id??""))throw new Error("wrangler whoami did not return a 32-character account id");process.stdout.write(id);' <<< "${WHOAMI_JSON}")"
if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && "${CLOUDFLARE_ACCOUNT_ID}" != "${ACCOUNT_ID}" ]]; then
  printf 'CLOUDFLARE_ACCOUNT_ID does not match wrangler whoami\n' >&2
  exit 2
fi
export CLOUDFLARE_ACCOUNT_ID="${ACCOUNT_ID}"

mkdir -p .artifacts
readonly PREFIX=".artifacts/g37-${CANDIDATE//[^a-zA-Z0-9._-]/-}-${SOURCE_COMMIT:0:12}"
readonly BEFORE_VERSIONS="${PREFIX}-versions-before.json"
readonly AFTER_VERSIONS="${PREFIX}-versions-after.json"
readonly OUTPUT="${PREFIX}.json"
readonly D1_MIGRATION_PREFIX="${PREFIX}-migrations"
readonly MESSAGE="SDT-G37 ${CANDIDATE} ${SERVICE_ID} ${SOURCE_COMMIT}"

# The primary config preserves the currently deployed G32 receiver binding
# plus persisted trace/log collection. G38's separately owned new receiver
# Worker is not yet live, so G37 neither creates it nor retargets to it.
"${WRANGLER_BIN}" deploy --config "${CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${SERVICE_ID}"

# The checked-in G32/G44 SQL is the schema authority for both deployed D1
# bindings. The applicator reads each remote catalog, executes only missing DDL,
# and verifies the required objects after execution. It runs on every sample so
# a partially provisioned database cannot recreate the earlier 500 partial_write.
node "${SCRIPT_DIR}/g37-d1-migrations.mjs" \
  --wrangler "${WRANGLER_BIN}" \
  --config "${REPO_ROOT}/${CONFIG}" \
  --database "${D1_DATABASE}" \
  --migration "${D1_BASELINE_MIGRATION}" \
  --migration "${D1_COMPLETENESS_MIGRATION}" \
  --output "${D1_MIGRATION_PREFIX}-d1.json"
node "${SCRIPT_DIR}/g37-d1-migrations.mjs" \
  --wrangler "${WRANGLER_BIN}" \
  --config "${REPO_ROOT}/${CONFIG}" \
  --database "${D1_MV_DATABASE}" \
  --migration "${D1_BASELINE_MIGRATION}" \
  --migration "${D1_COMPLETENESS_MIGRATION}" \
  --output "${D1_MIGRATION_PREFIX}-d1-mv.json"
"${WRANGLER_BIN}" versions list --name "${WORKER}" --json > "${BEFORE_VERSIONS}"

TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g37-conformance.XXXXXX")"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g37-secrets.XXXXXX")"
chmod 600 "${TOKEN_FILE}" "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${SECRETS_FILE}"' EXIT
openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
node -e 'const fs=require("fs");const token=fs.readFileSync(process.argv[1],"utf8").trim();if(!token)throw new Error("empty G37 conformance token");fs.writeFileSync(process.argv[2],JSON.stringify({CONFORMANCE_TOKEN:token})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${SECRETS_FILE}"

"${WRANGLER_BIN}" deploy --config "${CONFIG}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" --var "SDT_SERVICE_ID:${SERVICE_ID}" --message "${MESSAGE}"
sleep "${DEPLOY_SETTLE_SECONDS}"
"${WRANGLER_BIN}" versions list --name "${WORKER}" --json > "${AFTER_VERSIONS}"

node "${SCRIPT_DIR}/g37-sample.mjs" \
  --base-url "${BASE_URL}" \
  --token-file "${TOKEN_FILE}" \
  --account-id "${ACCOUNT_ID}" \
  --service-id "${SERVICE_ID}" \
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
