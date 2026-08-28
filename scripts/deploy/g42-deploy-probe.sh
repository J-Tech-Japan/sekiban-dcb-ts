#!/usr/bin/env bash
set -euo pipefail

# Deploys the SDT-G42 probe code through the existing primary configuration.
# This is deliberately code-only: the post-deploy witness rejects any runtime,
# handler, or binding projection change.  By default it stops after the build
# preflight; a caller must explicitly set G42_DEPLOY_LIVE=1 after CI is green.
# A caller that will immediately make P must supply G42_CONFORMANCE_TOKEN_FILE.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_BIN="${WRANGLER_BIN:-${REPO_ROOT}/node_modules/.bin/wrangler}"
readonly CONFIG="samples/meeting-room/wrangler.g37-primary.jsonc"
readonly WORKER="sekiban-dcb-meeting-room-cloudflare-only"
readonly SERVICE_ID="g32-9043d626fe1149cb"
readonly BASE_URL="${G42_BASE_URL:-https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev}"
readonly SOURCE_COMMIT="${G42_SOURCE_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
readonly ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
readonly LIVE_DEPLOY="${G42_DEPLOY_LIVE:-0}"

cd "${REPO_ROOT}"
test -x "${WRANGLER_BIN}"
test -f "${CONFIG}"
[[ "${SOURCE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]
[[ -z "$(git status --porcelain --untracked-files=no)" ]]

mkdir -p .artifacts
readonly PREFIX=".artifacts/g42-deploy-${SOURCE_COMMIT:0:12}"
readonly BUILD_DIR="${PREFIX}-build"
readonly COMMANDS="${PREFIX}-commands.txt"
readonly DRY_RUN_LOG="${PREFIX}-dry-run.log"
readonly DEPLOY_LOG="${PREFIX}-deploy.log"
readonly BEFORE_DEPLOYMENTS="${PREFIX}-deployments-before.json"
readonly AFTER_DEPLOYMENTS="${PREFIX}-deployments-after.json"
readonly BEFORE_VERSION="${PREFIX}-version-before.json"
readonly AFTER_VERSION="${PREFIX}-version-after.json"
readonly WITNESS="${PREFIX}-witness.json"
readonly PROVIDER="${PREFIX}-provider.json"
readonly BUILD_FACTS="${PREFIX}-build-facts.json"
readonly MESSAGE="SDT-G42 P1 probe ${SERVICE_ID} ${SOURCE_COMMIT}"

printf '%s\n' \
  "wrangler deploy --config ${CONFIG} --dry-run --strict --outdir ${BUILD_DIR} --outfile worker.js --metafile bundle-meta.json --var SDT_SERVICE_ID:${SERVICE_ID}" \
  "wrangler deployments list --name ${WORKER} --json" \
  "wrangler versions view <active-version> --name ${WORKER} --json" \
  "wrangler deploy --config ${CONFIG} --keep-vars --strict --secrets-file [protected] --var SDT_SERVICE_ID:${SERVICE_ID} --message ${MESSAGE}" \
  "wrangler deployments list --name ${WORKER} --json" \
  "wrangler versions view <deployed-version> --name ${WORKER} --json" \
  > "${COMMANDS}"

"${WRANGLER_BIN}" deploy --config "${CONFIG}" --dry-run --strict \
  --outdir "${BUILD_DIR}" --outfile "${BUILD_DIR}/worker.js" --metafile "${BUILD_DIR}/bundle-meta.json" \
  --var "SDT_SERVICE_ID:${SERVICE_ID}" > "${DRY_RUN_LOG}" 2>&1

readonly CONFIG_DIGEST="$(shasum -a 256 "${CONFIG}" | awk '{print $1}')"
readonly MODULE_BUNDLE_DIGEST="$(shasum -a 256 "${BUILD_DIR}/worker.js" | awk '{print $1}')"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({schema:"sdt.g42.build-facts/v1",sourceCommit:process.argv[2],configPath:process.argv[3],configDigest:process.argv[4],moduleBundleDigest:process.argv[5],worker:process.argv[6],baseUrl:process.argv[7],accountId:process.argv[8]},null,2)+"\n")' \
  "${BUILD_FACTS}" "${SOURCE_COMMIT}" "${CONFIG}" "${CONFIG_DIGEST}" "${MODULE_BUNDLE_DIGEST}" "${WORKER}" "${BASE_URL}" "${ACCOUNT_ID}"

if [[ "${LIVE_DEPLOY}" != "1" ]]; then
  printf 'G42 deploy preflight complete (live deployment requires G42_DEPLOY_LIVE=1): %s\n' "${BUILD_FACTS}"
  exit 0
fi

TOKEN_FILE="${G42_CONFORMANCE_TOKEN_FILE:-}"
OWN_TOKEN=0
if [[ -z "${TOKEN_FILE}" ]]; then
  TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g42-conformance.XXXXXX")"
  OWN_TOKEN=1
  chmod 600 "${TOKEN_FILE}"
  openssl rand -base64 48 | tr -d '\n' > "${TOKEN_FILE}"
else
  test -r "${TOKEN_FILE}"
  test -s "${TOKEN_FILE}"
fi
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/sdt-g42-secrets.XXXXXX")"
chmod 600 "${SECRETS_FILE}"
trap 'rm -f "${SECRETS_FILE}"; if [[ "${OWN_TOKEN}" -eq 1 ]]; then rm -f "${TOKEN_FILE}"; fi' EXIT

# The token value stays in these two protected files; neither shell command
# logging nor JSON evidence expands either file's content.
node -e 'const fs=require("fs");const token=fs.readFileSync(process.argv[1],"utf8").trim();if(!token)throw new Error("empty G42 conformance token");fs.writeFileSync(process.argv[2],JSON.stringify({CONFORMANCE_TOKEN:token})+"\n",{mode:0o600});' "${TOKEN_FILE}" "${SECRETS_FILE}"

"${WRANGLER_BIN}" deployments list --name "${WORKER}" --json > "${BEFORE_DEPLOYMENTS}"
readonly BEFORE_VERSION_ID="$(node "${SCRIPT_DIR}/g42-deployment-witness.mjs" --active-version-id --deployments "${BEFORE_DEPLOYMENTS}")"
"${WRANGLER_BIN}" versions view "${BEFORE_VERSION_ID}" --name "${WORKER}" --json > "${BEFORE_VERSION}"

"${WRANGLER_BIN}" deploy --config "${CONFIG}" --keep-vars --strict --secrets-file "${SECRETS_FILE}" \
  --var "SDT_SERVICE_ID:${SERVICE_ID}" --message "${MESSAGE}" > "${DEPLOY_LOG}" 2>&1

"${WRANGLER_BIN}" deployments list --name "${WORKER}" --json > "${AFTER_DEPLOYMENTS}"
readonly AFTER_VERSION_ID="$(node -e 'const fs=require("fs");const rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const matched=rows.filter((row)=>row?.annotations?.["workers/message"]===process.argv[2]);if(matched.length!==1)throw new Error(`expected one deployment message match, got ${matched.length}`);const row=matched[0];if(!Array.isArray(row.versions)||row.versions.length!==1||row.versions[0]?.percentage!==100)throw new Error("deployed version is not 100 percent active");process.stdout.write(row.versions[0].version_id)' "${AFTER_DEPLOYMENTS}" "${MESSAGE}")"
"${WRANGLER_BIN}" versions view "${AFTER_VERSION_ID}" --name "${WORKER}" --json > "${AFTER_VERSION}"

node "${SCRIPT_DIR}/g42-deployment-witness.mjs" \
  --before-deployments "${BEFORE_DEPLOYMENTS}" \
  --after-deployments "${AFTER_DEPLOYMENTS}" \
  --before-version "${BEFORE_VERSION}" \
  --after-version "${AFTER_VERSION}" \
  --message "${MESSAGE}" \
  --worker "${WORKER}" \
  --base-url "${BASE_URL}" \
  --source-commit "${SOURCE_COMMIT}" \
  --config "${CONFIG}" \
  --output "${WITNESS}"
node -e 'const fs=require("fs");const witness=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],JSON.stringify(witness.providerIdentity,null,2)+"\n")' "${WITNESS}" "${PROVIDER}"

printf 'G42 code-only deploy/read-back complete: %s\n' "${WITNESS}"
