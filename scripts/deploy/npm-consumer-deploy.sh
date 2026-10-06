#!/usr/bin/env bash
# SDT-G99: tip-deploy meeting-room Cloudflare-only using packed/registry packages
# (not monorepo file: resolution for @sekiban/dcb-{core,domain,client,runtime}).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

WORKER_NAME="${G99_WORKER_NAME:-sekiban-dcb-meeting-room-cloudflare-only}"
CONFIG="${G99_CONFIG:-samples/meeting-room/wrangler.cloudflare-only.jsonc}"
STAGE="${G99_STAGE_DIR:-.artifacts/sdt-g99-npm-consumer}"
SOURCE_COMMIT="$(git rev-parse HEAD)"
MESSAGE="${G99_DEPLOY_MESSAGE:-SDT-G99 npm-consumer tip ${SOURCE_COMMIT}}"

rm -rf "${STAGE}"
mkdir -p "${STAGE}/tarballs" "${STAGE}/app"

echo "g99-npm-consumer: building packages"
npm run build:packages >/dev/null

echo "g99-npm-consumer: packing matched set"
for pkg in dcb-core dcb-domain dcb-client dcb-runtime; do
  (
    cd "packages/${pkg}"
    tarball="$(npm pack --pack-destination "${ROOT}/${STAGE}/tarballs" | tail -n1)"
    echo "  packed ${pkg} -> ${tarball}"
  )
done

CORE_TGZ="$(ls "${STAGE}/tarballs"/sekiban-dcb-core-*.tgz | head -n1)"
DOMAIN_TGZ="$(ls "${STAGE}/tarballs"/sekiban-dcb-domain-*.tgz | head -n1)"
CLIENT_TGZ="$(ls "${STAGE}/tarballs"/sekiban-dcb-client-*.tgz | head -n1)"
RUNTIME_TGZ="$(ls "${STAGE}/tarballs"/sekiban-dcb-runtime-*.tgz | head -n1)"

echo "g99-npm-consumer: staging sample sources"
rsync -a \
  --exclude node_modules \
  --exclude .wrangler \
  --exclude dist \
  samples/meeting-room/ "${STAGE}/app/"

cat > "${STAGE}/app/package.json" <<EOF
{
  "name": "@sekiban/meeting-room-npm-consumer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@sekiban/dcb-client": "file:${ROOT}/${CLIENT_TGZ}",
    "@sekiban/dcb-core": "file:${ROOT}/${CORE_TGZ}",
    "@sekiban/dcb-domain": "file:${ROOT}/${DOMAIN_TGZ}",
    "@sekiban/dcb-runtime": "file:${ROOT}/${RUNTIME_TGZ}"
  }
}
EOF

# Rewrite wrangler main/config paths: deploy from staged app directory.
# Keep the same worker name / D1 bindings via the copied jsonc.
STAGE_CONFIG="${STAGE}/app/$(basename "${CONFIG}")"
if [[ ! -f "${STAGE_CONFIG}" ]]; then
  echo "missing staged config ${STAGE_CONFIG}" >&2
  exit 1
fi

# Relocate migrations_dir to the repo root so the staged config depth still works.
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.argv[1];
const configPath = process.argv[2];
const raw = readFileSync(configPath, 'utf8');
const rewritten = raw.replaceAll(
  /\"migrations_dir\"\\s*:\\s*\"([^\"]+)\"/g,
  (_match, relative) => {
    const absolute = resolve(root, 'samples/meeting-room', relative);
    return '\"migrations_dir\": \"' + absolute + '\"';
  },
);
writeFileSync(configPath, rewritten);
" "${ROOT}" "${STAGE_CONFIG}"

echo "g99-npm-consumer: installing from packed tarballs (no workspace link)"
(
  cd "${STAGE}/app"
  npm install --no-package-lock --install-links
)

# Prove resolution is not the monorepo packages/ tree.
RESOLVED_RUNTIME="$(cd "${STAGE}/app" && node --input-type=module -e "
import { realpathSync, readFileSync } from 'node:fs';
const dir = realpathSync('node_modules/@sekiban/dcb-runtime');
const manifest = JSON.parse(readFileSync(dir + '/package.json', 'utf8'));
if (manifest.name !== '@sekiban/dcb-runtime') throw new Error('unexpected ' + manifest.name);
console.log(dir);
")"
case "${RESOLVED_RUNTIME}" in
  "${ROOT}/packages/"*)
    echo "FAIL: resolved runtime still under packages/: ${RESOLVED_RUNTIME}" >&2
    exit 1
    ;;
esac
echo "g99-npm-consumer: resolved @sekiban/dcb-runtime -> ${RESOLVED_RUNTIME}"

RECEIPT="${ROOT}/.artifacts/sdt-g99-npm-consumer-deploy.json"
mkdir -p "${ROOT}/.artifacts"

if [[ "${G99_DRY_RUN:-}" == "1" ]]; then
  echo "g99-npm-consumer: dry-run only (G99_DRY_RUN=1)"
  cat > "${RECEIPT}" <<EOF
{
  "schema": "sdt-g99-npm-consumer-deploy/v1",
  "dryRun": true,
  "sourceCommit": "${SOURCE_COMMIT}",
  "worker": "${WORKER_NAME}",
  "config": "${CONFIG}",
  "stage": "${STAGE}",
  "resolvedRuntime": "${RESOLVED_RUNTIME}",
  "tarballs": {
    "core": "${CORE_TGZ}",
    "domain": "${DOMAIN_TGZ}",
    "client": "${CLIENT_TGZ}",
    "runtime": "${RUNTIME_TGZ}"
  }
}
EOF
  cat "${RECEIPT}"
  exit 0
fi

echo "g99-npm-consumer: deploying ${WORKER_NAME}"
DEPLOY_OUT="$(mktemp)"
(
  cd "${STAGE}/app"
  # Resolve @sekiban packages from the staged node_modules; wrangler bundles from main.
  CI=true npx wrangler deploy --config "$(basename "${CONFIG}")" --keep-vars \
    --message "${MESSAGE}" | tee "${DEPLOY_OUT}"
)

VERSION_ID="$(rg -o 'Current Version ID:[[:space:]]*[0-9a-f-]+' "${DEPLOY_OUT}" | awk '{print $NF}' | tail -n1 || true)"
if [[ -z "${VERSION_ID}" ]]; then
  VERSION_ID="$(rg -o 'Version ID:[[:space:]]*[0-9a-f-]+' "${DEPLOY_OUT}" | awk '{print $NF}' | tail -n1 || true)"
fi

cat > "${RECEIPT}" <<EOF
{
  "schema": "sdt-g99-npm-consumer-deploy/v1",
  "dryRun": false,
  "sourceCommit": "${SOURCE_COMMIT}",
  "worker": "${WORKER_NAME}",
  "config": "${CONFIG}",
  "message": "${MESSAGE}",
  "stage": "${STAGE}",
  "resolvedRuntime": "${RESOLVED_RUNTIME}",
  "versionId": "${VERSION_ID}",
  "tarballs": {
    "core": "${CORE_TGZ}",
    "domain": "${DOMAIN_TGZ}",
    "client": "${CLIENT_TGZ}",
    "runtime": "${RUNTIME_TGZ}"
  },
  "recordedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "g99-npm-consumer: receipt ${RECEIPT}"
cat "${RECEIPT}"
