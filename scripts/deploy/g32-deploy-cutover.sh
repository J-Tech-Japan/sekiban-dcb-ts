#!/usr/bin/env bash
set -euo pipefail

# SDT-G32 final-C production cutover. This script intentionally has two
# modes: the default is a no-write preflight; the one witnessed production run
# requires G32_DEPLOY_LIVE=1 after C is sealed and tracked files are clean.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_CONFIG="samples/meeting-room/wrangler.g32-final-primary.jsonc"
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.g32-final-receiver.jsonc"
readonly D1_CONFIG_DIR="samples/meeting-room"
readonly PRIMARY_CONFIG_NAME="wrangler.g32-final-primary.jsonc"
readonly SERVICE_ID="g32-9043d626fe1149cb"
readonly PIPELINE_DATABASE="sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline"
readonly MATERIALIZED_VIEW_DATABASE="sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv"
readonly QUEUE_NAME="sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox"
readonly PRIMARY_WORKER="sekiban-dcb-meeting-room-cloudflare-only"
readonly RECEIVER_WORKER="sekiban-dcb-meeting-room-doorbell"
readonly PRIMARY_BASE_URL="${G32_PRIMARY_BASE_URL:-https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev}"
readonly RECEIVER_BASE_URL="${G32_RECEIVER_BASE_URL:-https://sekiban-dcb-meeting-room-doorbell.ttakaoka.workers.dev}"
readonly SOURCE_COMMIT="${G32_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly PRE_FILE="${REPO_ROOT}/.artifacts/g32-pre-witness.json"
readonly POST_FILE="${REPO_ROOT}/.artifacts/g32-post-witness.json"
readonly QUEUE_CONSUMERS_FILE="${REPO_ROOT}/.artifacts/g32-queue-consumers.json"
readonly QUEUE_TOPOLOGY_FILE="${REPO_ROOT}/.artifacts/g32-queue-topology.json"
readonly MEASUREMENT_FILE="${REPO_ROOT}/.artifacts/g32-measurement.json"

cd "${REPO_ROOT}"

# Composition gates fail before cleanliness checks and before any wrangler
# process, including dry-run and d1. The wrapper is the path CI also calls.
node scripts/g32-cutover-check.mjs

test -x "${WRANGLER_BIN}"
if [[ "$(git rev-parse HEAD)" != "${SOURCE_COMMIT}" ]]; then
  printf 'G32_SOURCE_COMMIT must equal the sealed checked-out final candidate\n' >&2
  exit 2
fi
if [[ ! "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'G32 source commit must be a full SHA\n' >&2
  exit 2
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf 'G32 final candidate must have no tracked working-tree changes before its witnessed deploy\n' >&2
  exit 2
fi

# These gates fail before migrations, deployment, or any new-store command.
node scripts/g32-candidate-check.mjs --self-test
node scripts/g32-candidate-check.mjs
CONFIG_DIGEST="$(node scripts/deploy/g32-config-digest.mjs "${SOURCE_COMMIT}")"
if [[ ! "${CONFIG_DIGEST}" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'G32 deployment config digest could not be calculated\n' >&2
  exit 2
fi

COMMON_VARS=(
  --var "SDT_SERVICE_ID:${SERVICE_ID}"
  --var "G32_SOURCE_COMMIT:${SOURCE_COMMIT}"
  --var "G32_CONFIG_DIGEST:${CONFIG_DIGEST}"
)

# Phase 0: checked-in final config must build against the exact new bindings.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict "${COMMON_VARS[@]}" --var "G32_CUTOVER_FENCE_FINGERPRINT:$(printf '0%.0s' {1..64})"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --dry-run --strict "${COMMON_VARS[@]}" --var "G32_CUTOVER_FENCE_FINGERPRINT:$(printf '0%.0s' {1..64})"
"${WRANGLER_BIN}" d1 migrations list "${PIPELINE_DATABASE}" --cwd "${D1_CONFIG_DIR}" --config "${PRIMARY_CONFIG_NAME}" --remote
"${WRANGLER_BIN}" d1 migrations list "${MATERIALIZED_VIEW_DATABASE}" --cwd "${D1_CONFIG_DIR}" --config "${PRIMARY_CONFIG_NAME}" --remote

if [[ "${G32_DEPLOY_LIVE:-0}" != "1" ]]; then
  printf 'G32 final-C preflight PASS; set G32_DEPLOY_LIVE=1 for the once-sealed witnessed cutover\n'
  exit 0
fi

mkdir -p .artifacts

# Phase 1: B is already frozen. Capture the wipe allowlist, an empty fresh-D1
# schema witness, and an other-service witness before touching the new stores.
node scripts/deploy/g32-witness.mjs --mode pre --wrangler "${WRANGLER_BIN}" --output "${PRE_FILE}"

# The conformance bearer and final fencing token are new values supplied only
# through files. Their values never appear in arguments, logs, or evidence.
TOKEN_FILE="${G32_CONFORMANCE_TOKEN_FILE:-$(mktemp "${TMPDIR:-/tmp}/sdt-g32-conformance.XXXXXX")}"
FENCE_FILE="${G32_CUTOVER_FENCE_TOKEN_FILE:-$(mktemp "${TMPDIR:-/tmp}/sdt-g32-fence.XXXXXX")}"
BRIDGE_INVALIDATION_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g32-bridge-invalidation.XXXXXX")"
chmod 600 "${TOKEN_FILE}" "${FENCE_FILE}" "${BRIDGE_INVALIDATION_FILE}"
if [[ -z "${G32_CONFORMANCE_TOKEN_FILE:-}" ]]; then openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"; fi
if [[ -z "${G32_CUTOVER_FENCE_TOKEN_FILE:-}" ]]; then openssl rand -base64 48 | tr -d '\n' > "${FENCE_FILE}"; fi
openssl rand -base64 48 | tr -d '\n' > "${BRIDGE_INVALIDATION_FILE}"
test -s "${TOKEN_FILE}"
test -s "${FENCE_FILE}"
test -s "${BRIDGE_INVALIDATION_FILE}"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g32-secrets.XXXXXX")"
chmod 600 "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${FENCE_FILE}" "${BRIDGE_INVALIDATION_FILE}" "${SECRETS_FILE}"' EXIT
FENCE_FINGERPRINT="$(node -e 'const fs=require("fs");const {createHash}=require("crypto");const value=fs.readFileSync(process.argv[1],"utf8").trim();if(!value)throw new Error("empty G32 cutover fence token");process.stdout.write(createHash("sha256").update(value,"utf8").digest("hex"));' "${FENCE_FILE}")"
node -e 'const fs=require("fs");const conformance=fs.readFileSync(process.argv[1],"utf8").trim();const fence=fs.readFileSync(process.argv[2],"utf8").trim();const invalidation=fs.readFileSync(process.argv[3],"utf8").trim();if(!conformance||!fence||!invalidation)throw new Error("empty G32 deployment secret");fs.writeFileSync(process.argv[4],JSON.stringify({CONFORMANCE_TOKEN:conformance,G32_CUTOVER_FENCE_TOKEN:fence,G32_FREEZE_TOKEN:invalidation})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${FENCE_FILE}" "${BRIDGE_INVALIDATION_FILE}" "${SECRETS_FILE}"

# Phase 2: apply only fresh-database baseline migrations. No old D1 database,
# Durable Object namespace, or old Queue is read or modified here.
"${WRANGLER_BIN}" d1 migrations apply "${PIPELINE_DATABASE}" --cwd "${D1_CONFIG_DIR}" --config "${PRIMARY_CONFIG_NAME}" --remote
"${WRANGLER_BIN}" d1 migrations apply "${MATERIALIZED_VIEW_DATABASE}" --cwd "${D1_CONFIG_DIR}" --config "${PRIMARY_CONFIG_NAME}" --remote

# Phase 3: receiver first, then primary. The same final-C config digest and
# fence fingerprint reach both versions. G32_FREEZE_TOKEN is simultaneously
# rotated to an unrelated generated value, invalidating B's token; final code
# never reads it and has no bridge route. All local token files are deleted by
# this script's trap.
FINAL_VARS=("${COMMON_VARS[@]}" --var "G32_CUTOVER_FENCE_FINGERPRINT:${FENCE_FINGERPRINT}")
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --strict --secrets-file "${SECRETS_FILE}" "${FINAL_VARS[@]}" --message "SDT-G32 final C receiver ${SOURCE_COMMIT}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --strict --secrets-file "${SECRETS_FILE}" "${FINAL_VARS[@]}" --message "SDT-G32 final C primary ${SOURCE_COMMIT}"

# Queue ownership is a remote topology fact. Wait briefly for Cloudflare's
# consumer registration; receiver must never become a Queue consumer.
for attempt in {1..15}; do
  "${WRANGLER_BIN}" queues consumer worker list "${QUEUE_NAME}" --json > "${QUEUE_CONSUMERS_FILE}"
  if node scripts/deploy/g32-queue-topology.mjs --input "${QUEUE_CONSUMERS_FILE}" --output "${QUEUE_TOPOLOGY_FILE}"; then
    break
  fi
  if [[ "${attempt}" == "15" ]]; then
    printf 'G32 final Queue consumer topology did not converge\n' >&2
    exit 1
  fi
  sleep 2
done

# Phase 4: the authenticated post witness checks both component identities,
# the matching final fence, the empty fresh logical store, old route closure,
# and the pre-captured non-cutover resource set before the first application
# command is allowed to write a G32 logical record.
node scripts/deploy/g32-witness.mjs \
  --conformance-retry-attempts 15 --conformance-retry-delay-ms 1000 \
  --wrangler "${WRANGLER_BIN}" --base-url "${PRIMARY_BASE_URL}" --receiver-base-url "${RECEIVER_BASE_URL}" \
  --token-file "${TOKEN_FILE}" --source-commit "${SOURCE_COMMIT}" --config-digest "${CONFIG_DIGEST}" --output "${POST_FILE}"
node scripts/deploy/g32-witness.mjs --mode compare --before "${PRE_FILE}" --after "${POST_FILE}" --source-commit "${SOURCE_COMMIT}"

# Phase 5 is the only intentional application-write phase. The measurement
# performs exactly N=10 reserve -> one server wait/list redraw cycles and
# records all raw timestamps plus a 37-character old-SUID typed negative.
node scripts/deploy/g32-measure.mjs --base-url "${PRIMARY_BASE_URL}" --token-file "${TOKEN_FILE}" --samples 10 --report "${MEASUREMENT_FILE}"
node scripts/deploy/g32-record-evidence.mjs \
  --source-commit "${SOURCE_COMMIT}" --pre "${PRE_FILE}" --post "${POST_FILE}" \
  --measurement "${MEASUREMENT_FILE}" --queue-topology "${QUEUE_TOPOLOGY_FILE}" \
  --output docs/SDT-G32-cutover-evidence.json

printf 'G32 final-C witnessed cutover complete; only evidence and retained-C bookkeeping may follow\n'
