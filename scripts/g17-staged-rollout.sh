#!/usr/bin/env bash
set -euo pipefail

# F-RT-1 remediation is deliberately staged.  A unique SUID constraint is
# never attempted until the exact target cleanup has been recorded and
# verified.  The connection string is consumed by psql and is never echoed.

phase="${1:-dry-run}"
target="${G17_TARGET_SERVICE_ID:-serialized-dcb-v1}"
fresh_service_id="${G17_FRESH_SERVICE_ID:-g17-fresh-$(date +%s)}"
state_file="${G17_ROLLOUT_STATE_FILE:-.artifacts/g17-rollout-state.json}"

if [[ -z "${POSTGRES_URL:-}" ]]; then
  echo "POSTGRES_URL is required" >&2
  exit 2
fi
if [[ ! "$target" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  echo "G17_TARGET_SERVICE_ID contains unsupported characters" >&2
  exit 2
fi

mkdir -p "$(dirname "$state_file")"

psql_count() {
  psql_cmd "$POSTGRES_URL" -X -v ON_ERROR_STOP=1 -At -v target="$target" -c "$1" | tr -d '[:space:]'
}

psql_cmd() {
  if command -v psql >/dev/null 2>&1; then
    command psql "$@"
    return
  fi
  if [[ -n "${G17_POSTGRES_CONTAINER:-}" ]]; then
    # Local evidence may use the already-running test container without
    # copying its connection string into any artifact.
    docker exec -i "$G17_POSTGRES_CONTAINER" psql -U postgres -d serialized_dcb "${@:2}"
    return
  fi
  echo "psql is required (or set G17_POSTGRES_CONTAINER for local Docker evidence)" >&2
  exit 2
}

require_recorded_target() {
  if [[ ! -s "$state_file" ]] || ! grep -Fq "\"targetServiceId\":\"$target\"" "$state_file"; then
    echo "rollout state was not recorded for the exact target serviceId" >&2
    exit 2
  fi
}

case "$phase" in
  dry-run)
    duplicate_pairs="$(psql_count "SELECT count(*) FROM (SELECT suid FROM serialized_dcb_events WHERE service_id = '$target' GROUP BY suid HAVING count(*) > 1) duplicate_pairs;")"
    duplicate_rows="$(psql_count "SELECT coalesce(sum(pair_count - 1), 0) FROM (SELECT count(*) AS pair_count FROM serialized_dcb_events WHERE service_id = '$target' GROUP BY suid HAVING count(*) > 1) duplicate_rows;")"
    echo "phase=dry-run targetServiceId=$target duplicatePairs=$duplicate_pairs duplicateRowsToQuarantine=$duplicate_rows"
    echo "duplicateTargets:"
    psql_cmd "$POSTGRES_URL" -X -v ON_ERROR_STOP=1 -At -F $'\t' -v target="$target" -c \
      "SELECT suid, count(*) FROM serialized_dcb_events WHERE service_id = '$target' GROUP BY suid HAVING count(*) > 1 ORDER BY suid;"
    printf '{"targetServiceId":"%s","duplicatePairs":%s,"duplicateRowsToQuarantine":%s,"cleanupRecorded":false,"constraintDeployed":false}\n' \
      "$target" "$duplicate_pairs" "$duplicate_rows" > "$state_file"
    ;;
  cleanup)
    if [[ "${G17_CLEANUP_CONFIRM:-}" != "YES" ]]; then
      echo "cleanup requires G17_CLEANUP_CONFIRM=YES after dry-run" >&2
      exit 2
    fi
    require_recorded_target
    psql_cmd "$POSTGRES_URL" -X -v ON_ERROR_STOP=1 <<SQL
BEGIN;
WITH ranked AS (
  SELECT ctid, row_number() OVER (PARTITION BY service_id, suid ORDER BY event_id ASC) AS ordinal
    FROM serialized_dcb_events
   WHERE service_id = '$target'
)
DELETE FROM serialized_dcb_events AS event
 USING ranked
 WHERE event.ctid = ranked.ctid AND ranked.ordinal > 1;
COMMIT;
SQL
    remaining="$(psql_count "SELECT count(*) FROM (SELECT suid FROM serialized_dcb_events WHERE service_id = '$target' GROUP BY suid HAVING count(*) > 1) remaining;")"
    if [[ "$remaining" != "0" ]]; then
      echo "cleanup did not reach duplicatePairs=0 for exact target" >&2
      exit 1
    fi
    printf '{"targetServiceId":"%s","duplicatePairs":0,"duplicateRowsToQuarantine":0,"cleanupRecorded":true,"constraintDeployed":false}\n' \
      "$target" > "$state_file"
    echo "phase=cleanup targetServiceId=$target remainingDuplicatePairs=$remaining"
    ;;
  constraint)
    require_recorded_target
    if ! grep -q '"cleanupRecorded":true' "$state_file"; then
      echo "constraint requires a successful cleanup phase; refusing pre-cleanup migration" >&2
      exit 2
    fi
    all_remaining="$(psql_cmd "$POSTGRES_URL" -X -v ON_ERROR_STOP=1 -At -c \
      "SELECT count(*) FROM (SELECT service_id, suid FROM serialized_dcb_events GROUP BY service_id, suid HAVING count(*) > 1) remaining;" | tr -d '[:space:]')"
    if [[ "$all_remaining" != "0" ]]; then
      echo "unscoped duplicate pairs remain; constraint deployment is refused" >&2
      exit 1
    fi
    psql_cmd "$POSTGRES_URL" -X -v ON_ERROR_STOP=1 -c \
      'CREATE UNIQUE INDEX IF NOT EXISTS serialized_dcb_events_service_suid_unique_idx ON serialized_dcb_events (service_id, suid);' >/dev/null
    printf '{"targetServiceId":"%s","duplicatePairs":0,"duplicateRowsToQuarantine":0,"cleanupRecorded":true,"constraintDeployed":true}\n' \
      "$target" > "$state_file"
    echo "phase=constraint targetServiceId=$target allRemainingDuplicatePairs=$all_remaining uniqueIndex=deployed"
    ;;
  resume)
    require_recorded_target
    if ! grep -q '"constraintDeployed":true' "$state_file"; then
      echo "resume requires cleanup and constraint phases" >&2
      exit 2
    fi
    echo "phase=resume freshServiceId=$fresh_service_id duplicatePairs=0"
    ;;
  *)
    echo "usage: $0 {dry-run|cleanup|constraint|resume}" >&2
    exit 2
    ;;
esac
