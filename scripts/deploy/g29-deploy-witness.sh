#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly PRIMARY_CONFIG="samples/meeting-room/wrangler.cloudflare-only-doorbell.jsonc"
# The non-public receiver is a service-binding target only.  The primary owns
# the outbox Queue consumer, so this production config intentionally has no
# queues.consumers block.
readonly RECEIVER_CONFIG="samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc"
readonly SERVICE_ID="${G29_SERVICE_ID:-g25-38219c8-20260820f}"
readonly SOURCE_COMMIT="${G29_SOURCE_COMMIT:-$(git rev-parse HEAD)}"
readonly BASE_URL="${G29_BASE_URL:-https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev}"
readonly QUEUE_NAME="sekiban-dcb-meeting-room-cloudflare-outbox"
readonly RECEIVER_WORKER="sekiban-dcb-meeting-room-doorbell"
readonly PRIMARY_WORKER="sekiban-dcb-meeting-room-cloudflare-only"
readonly EXPECTED_FILE="${REPO_ROOT}/.artifacts/g29-witness-expected.json"
readonly BEFORE_EXPECTED_FILE="${REPO_ROOT}/.artifacts/g29-witness-before-expected.json"
readonly PRE_FILE="${REPO_ROOT}/.artifacts/g29-pre-witness.json"
readonly POST_FILE="${REPO_ROOT}/.artifacts/g29-post-witness.json"
readonly CONSUMERS_BEFORE_FILE="${REPO_ROOT}/.artifacts/g29-receiver-consumers-before.json"
readonly CONSUMERS_AFTER_FILE="${REPO_ROOT}/.artifacts/g29-receiver-consumers-after.json"
readonly CONSUMER_TOPOLOGY_FILE="${REPO_ROOT}/.artifacts/g29-receiver-consumer-topology.json"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
if [[ ! "${SERVICE_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]]; then
  printf 'G29_SERVICE_ID must be the existing non-secret deployment identity\n' >&2
  exit 2
fi
mkdir -p .artifacts
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({worker:"sekiban-dcb-meeting-room-cloudflare-only",serviceId:process.argv[2],viewCount:2,allowedViews:["RoomProjector","ReservationProjector"],domainDeliveryClass:"immediate-preferred",resolvedDeliveryClass:"immediate-preferred",domainViewDeliveryClasses:{RoomProjector:"immediate-preferred",ReservationProjector:"immediate-preferred"},directDoorbell:true,receiverMode:"separate",degradation:"queued-degraded",maxServiceBindingInvocations:32,pipelineDatabaseId:"3c3b1641-7969-4d72-97a9-2ea65085c9bb",materializedViewDatabaseId:"5db45136-f1dd-4f4d-bfe3-b6328193a1ac",queue:"sekiban-dcb-meeting-room-cloudflare-outbox",generation:"v2"},null,2)+"\n")' "${EXPECTED_FILE}" "${SERVICE_ID}"
cp "${EXPECTED_FILE}" "${BEFORE_EXPECTED_FILE}"

# Phase 1: checked-in config and bundle preflight. No deployment or data write.
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G29_SOURCE_COMMIT:${SOURCE_COMMIT}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --dry-run --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G29_SOURCE_COMMIT:${SOURCE_COMMIT}"
"${WRANGLER_BIN}" d1 migrations list sekiban-dcb-meeting-room-cloudflare-pipeline --config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote
"${WRANGLER_BIN}" d1 migrations list sekiban-dcb-meeting-room-cloudflare-mv --config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote

if [[ "${G29_DEPLOY_LIVE:-0}" != "1" ]]; then
  printf 'G29 preflight PASS; set G29_DEPLOY_LIVE=1 with G29_CONFORMANCE_TOKEN_FILE for witnessed deploy\n'
  exit 0
fi
TOKEN_FILE="${G29_CONFORMANCE_TOKEN_FILE:-}"
if [[ -z "${TOKEN_FILE}" ]]; then
  TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g29-token.XXXXXX")"
  chmod 600 "${TOKEN_FILE}"
  openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
fi
test -f "${TOKEN_FILE}"
trap 'rm -f "${TOKEN_FILE}"' EXIT

# Rotate the conformance secret from protected file input.  The value is never
# placed in arguments, logs, or evidence.  This changes only the bearer secret;
# it does not touch D1, Durable Objects, Queue state, or the service identity.
"${WRANGLER_BIN}" secret put CONFORMANCE_TOKEN --name "sekiban-dcb-meeting-room-cloudflare-only" < "${TOKEN_FILE}"

# Phase 2: pre-witness is captured before either Worker is changed.
node scripts/deploy/g29-witness.mjs --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --service-id "${SERVICE_ID}" --output "${PRE_FILE}"

# Phase 3: the sealed final C is always deployed after the pre-witness.  The
# migration commands are retained as checked-in no-op-or-additive checks; no
# data reset, new service identity, or destructive migration is permitted.
"${WRANGLER_BIN}" d1 migrations apply sekiban-dcb-meeting-room-cloudflare-pipeline --config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote
"${WRANGLER_BIN}" d1 migrations apply sekiban-dcb-meeting-room-cloudflare-mv --config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote

# Remove only an incorrect receiver consumer, never the primary consumer. The
# production receiver config below has no Queue consumer and cannot recreate it.
"${WRANGLER_BIN}" queues consumer worker list "${QUEUE_NAME}" --json > "${CONSUMERS_BEFORE_FILE}"
RECEIVER_CONSUMER_REMOVED=false
if node scripts/deploy/g29-receiver-consumer-topology.mjs --mode needs-removal --input "${CONSUMERS_BEFORE_FILE}" --receiver "${RECEIVER_WORKER}" --primary "${PRIMARY_WORKER}"; then
  "${WRANGLER_BIN}" queues consumer worker remove "${QUEUE_NAME}" "${RECEIVER_WORKER}"
  RECEIVER_CONSUMER_REMOVED=true
fi
"${WRANGLER_BIN}" deploy --config "${RECEIVER_CONFIG}" --keep-vars --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G29_SOURCE_COMMIT:${SOURCE_COMMIT}" --message "SDT-G29 witnessed receiver redeploy ${SERVICE_ID}"
"${WRANGLER_BIN}" deploy --config "${PRIMARY_CONFIG}" --keep-vars --strict --var "SDT_SERVICE_ID:${SERVICE_ID}" --var "G29_SOURCE_COMMIT:${SOURCE_COMMIT}" --message "SDT-G29 witnessed primary redeploy ${SERVICE_ID}"
"${WRANGLER_BIN}" queues consumer worker list "${QUEUE_NAME}" --json > "${CONSUMERS_AFTER_FILE}"
node scripts/deploy/g29-receiver-consumer-topology.mjs --mode record --queue "${QUEUE_NAME}" --before "${CONSUMERS_BEFORE_FILE}" --after "${CONSUMERS_AFTER_FILE}" --receiver "${RECEIVER_WORKER}" --primary "${PRIMARY_WORKER}" --removed "${RECEIVER_CONSUMER_REMOVED}" --output "${CONSUMER_TOPOLOGY_FILE}"

# Phase 4: post-witness must prove the same identity/topology before any fixed-N command.
node scripts/deploy/g29-witness.mjs --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --service-id "${SERVICE_ID}" --output "${POST_FILE}"
node scripts/deploy/g29-witness.mjs --mode compare --before "${PRE_FILE}" --after "${POST_FILE}" --expected "${EXPECTED_FILE}" --before-expected "${BEFORE_EXPECTED_FILE}" --source-commit "${SOURCE_COMMIT}"

# Phase 5: fixed N is intentionally last and records response->visible apart
# from total command->visible; total is never described as sub-second.
node scripts/deploy/g29-measure.mjs --base-url "${BASE_URL}" --token-file "${TOKEN_FILE}" --samples "${G29_SAMPLES:-10}" --report "${G29_REPORT:-.artifacts/g29-measurement.json}"
node scripts/deploy/g29-record-evidence.mjs --source-commit "${SOURCE_COMMIT}" --measurement "${G29_REPORT:-.artifacts/g29-measurement.json}" --receiver-topology "${CONSUMER_TOPOLOGY_FILE}" --primary-deploy-mode "deployed-final-c" --output docs/SDT-G29-deploy-evidence.json
