#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_CONFIG="samples/meeting-room/wrangler.cloudflare-only-doorbell.jsonc"
readonly D1_CONFIG_DIR="samples/meeting-room"
readonly D1_CONFIG="wrangler.cloudflare-only.jsonc"
# The non-public receiver is service-binding-only. The primary is the sole
# outbox Queue consumer, so this production config intentionally lacks queues.consumers.
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc"
readonly SERVICE_ID="${G31_SERVICE_ID:-g25-38219c8-20260820f}"
readonly SOURCE_COMMIT="${G31_SOURCE_COMMIT:-$(git rev-parse HEAD)}"
readonly BASE_URL="${G31_BASE_URL:-https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev}"
readonly QUEUE_NAME="sekiban-dcb-meeting-room-cloudflare-outbox"
readonly RECEIVER_WORKER="sekiban-dcb-meeting-room-doorbell"
readonly PRIMARY_WORKER="sekiban-dcb-meeting-room-cloudflare-only"
readonly EXPECTED_FILE="${REPO_ROOT}/.artifacts/g31-witness-expected.json"
readonly PRE_FILE="${REPO_ROOT}/.artifacts/g31-pre-witness.json"
readonly POST_FILE="${REPO_ROOT}/.artifacts/g31-post-witness.json"
readonly CONSUMERS_BEFORE_FILE="${REPO_ROOT}/.artifacts/g31-receiver-consumers-before.json"
readonly CONSUMERS_AFTER_FILE="${REPO_ROOT}/.artifacts/g31-receiver-consumers-after.json"
readonly CONSUMER_TOPOLOGY_FILE="${REPO_ROOT}/.artifacts/g31-receiver-consumer-topology.json"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
if [[ ! "${SERVICE_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  printf 'G31_SERVICE_ID must be the existing non-secret deployment identity\n' >&2
  exit 2
fi
if [[ "$(git rev-parse HEAD)" != "${SOURCE_COMMIT}" ]]; then
  printf 'G31_SOURCE_COMMIT must equal the sealed checked-out final candidate\n' >&2
  exit 2
fi
mkdir -p .artifacts
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({worker:"sekiban-dcb-meeting-room-cloudflare-only",serviceId:process.argv[2],pipelineDatabaseId:"3c3b1641-7969-4d72-97a9-2ea65085c9bb",materializedViewDatabaseId:"5db45136-f1dd-4f4d-bfe3-b6328193a1ac",queue:"sekiban-dcb-meeting-room-cloudflare-outbox",generation:"v2",waitFor:{sourceTarget:"unique-indexed-point-read",activeReceipt:"generation-definition-bound",safeHead:"unique-source-required",maxPointReads:252},directDoorbell:true,allowedViews:["RoomProjector","ReservationProjector"]},null,2)+"\n")' "${EXPECTED_FILE}" "${SERVICE_ID}"

# Phase 1: sealed config/bundle/migration preflight only. No deployment or data write.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G31_SOURCE_COMMIT:${SOURCE_COMMIT}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G31_SOURCE_COMMIT:${SOURCE_COMMIT}"
"${WRANGLER_BIN}" d1 migrations list sekiban-dcb-meeting-room-cloudflare-pipeline --cwd "${D1_CONFIG_DIR}" --config "${D1_CONFIG}" --remote
"${WRANGLER_BIN}" d1 migrations list sekiban-dcb-meeting-room-cloudflare-mv --cwd "${D1_CONFIG_DIR}" --config "${D1_CONFIG}" --remote

if [[ "${G31_DEPLOY_LIVE:-0}" != "1" ]]; then
  printf 'G31 preflight PASS; set G31_DEPLOY_LIVE=1 for the one final-C witnessed deploy\n'
  exit 0
fi

# Phase 2: capture the public witness set before any token read, deployment,
# migration apply, or probe command. It contains rows/heads/counts/lists and raw V1 closure.
node scripts/deploy/g31-witness.mjs --mode pre-deploy-public --base-url "${BASE_URL}" --output "${PRE_FILE}"

# Phase 3: rotate the conformance token only as part of the final primary-C
# deployment. The generated value is never a command argument, log, or evidence field.
TOKEN_FILE="${G31_CONFORMANCE_TOKEN_FILE:-}"
if [[ -z "${TOKEN_FILE}" ]]; then
  TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g31-token.XXXXXX")"
  chmod 600 "${TOKEN_FILE}"
  openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
fi
test -f "${TOKEN_FILE}"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g31-secrets.XXXXXX")"
chmod 600 "${SECRETS_FILE}"
trap 'rm -f "${TOKEN_FILE}" "${SECRETS_FILE}"' EXIT
node -e 'const fs=require("fs"); const token=fs.readFileSync(process.argv[1],"utf8").trim(); if(token.length===0) throw new Error("G31 conformance token file is empty"); fs.writeFileSync(process.argv[2],JSON.stringify({CONFORMANCE_TOKEN:token})+"\n",{mode:0o600})' "${TOKEN_FILE}" "${SECRETS_FILE}"

# These migration applications are only checked-in additive/no-op migrations.
# This workflow never resets data, reseeds IDs, or recreates Durable Objects.
"${WRANGLER_BIN}" d1 migrations apply sekiban-dcb-meeting-room-cloudflare-pipeline --cwd "${D1_CONFIG_DIR}" --config "${D1_CONFIG}" --remote
"${WRANGLER_BIN}" d1 migrations apply sekiban-dcb-meeting-room-cloudflare-mv --cwd "${D1_CONFIG_DIR}" --config "${D1_CONFIG}" --remote

# Remove only an erroneous legacy receiver consumer. The receiver config below
# cannot recreate it; the primary remains the sole consumer.
"${WRANGLER_BIN}" queues consumer worker list "${QUEUE_NAME}" --json > "${CONSUMERS_BEFORE_FILE}"
RECEIVER_CONSUMER_REMOVED=false
if node scripts/deploy/g31-receiver-consumer-topology.mjs --mode needs-removal --input "${CONSUMERS_BEFORE_FILE}" --receiver "${RECEIVER_WORKER}" --primary "${PRIMARY_WORKER}"; then
  "${WRANGLER_BIN}" queues consumer worker remove "${QUEUE_NAME}" "${RECEIVER_WORKER}"
  RECEIVER_CONSUMER_REMOVED=true
fi
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --keep-vars --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G31_SOURCE_COMMIT:${SOURCE_COMMIT}" --message "SDT-G31 witnessed receiver redeploy ${SERVICE_ID}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G31_SOURCE_COMMIT:${SOURCE_COMMIT}" --message "SDT-G31 witnessed primary redeploy ${SERVICE_ID}"
"${WRANGLER_BIN}" queues consumer worker list "${QUEUE_NAME}" --json > "${CONSUMERS_AFTER_FILE}"
node scripts/deploy/g31-receiver-consumer-topology.mjs --mode record --queue "${QUEUE_NAME}" --before "${CONSUMERS_BEFORE_FILE}" --after "${CONSUMERS_AFTER_FILE}" --receiver "${RECEIVER_WORKER}" --primary "${PRIMARY_WORKER}" --removed "${RECEIVER_CONSUMER_REMOVED}" --output "${CONSUMER_TOPOLOGY_FILE}"

# Phase 4: authenticate only with the rotated token, require the sealed source
# identity, and prove the complete pre-captured witness set remains intact.
node scripts/deploy/g31-witness.mjs --conformance-retry-attempts 15 --conformance-retry-delay-ms 1000 --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --service-id "${SERVICE_ID}" --output "${POST_FILE}"
node scripts/deploy/g31-witness.mjs --mode compare --before "${PRE_FILE}" --after "${POST_FILE}" --expected "${EXPECTED_FILE}" --source-commit "${SOURCE_COMMIT}"

# Phase 5: exactly fixed N=10 command→one server wait/list redraw cycles,
# then a separately recorded old SUID proof after its direct receipt has been GC'd.
node scripts/deploy/g31-measure.mjs --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --samples "${G31_SAMPLES:-10}" --report "${G31_REPORT:-.artifacts/g31-measurement.json}"
node scripts/deploy/g31-record-evidence.mjs --source-commit "${SOURCE_COMMIT}" --measurement "${G31_REPORT:-.artifacts/g31-measurement.json}" --receiver-topology "${CONSUMER_TOPOLOGY_FILE}" --output docs/SDT-G31-deploy-evidence.json
