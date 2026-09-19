#!/usr/bin/env bash
#
# A consistent dump of the desk's database, kept for a fortnight.
#
#   ./deploy/backup-db.sh                 -> backups/btc_desk-<utc stamp>.dump
#   ./deploy/backup-db.sh --restore FILE  -> replace the database with that dump
#
# `pg_dump -Fc` inside the db container: a single transaction's view of every
# table, taken while the desk keeps trading, and restorable table by table with
# pg_restore. Schedule it from cron after the 12:00 UTC settlement, beside
# refresh.sh:
#
#   30 12 * * *  cd ~/btc-desk && ./deploy/backup-db.sh >> backup.log 2>&1
#
# Restoring STOPS the API first -- a journal replaced under a running engine is
# a journal the engine is no longer reading -- and starts it again after.
# chain.db is not in here: it is a file on the data volume, rebuilt by the
# harvester, and export-data.sh packs it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f ${ROOT}/deploy/docker-compose.yml"
OUT_DIR="${BACKUP_DIR:-$ROOT/backups}"
KEEP="${KEEP_BACKUPS:-14}"
WEB_PORT="${WEB_PORT:-8099}"
DESK_HOST="${DESK_HOST:-172.17.0.1}"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker is not installed"
$COMPOSE ps --status running -q db 2>/dev/null | grep -q . || fail "the db container is not running"

if [[ "${1:-}" == "--restore" ]]; then
  FILE="${2:?--restore needs a dump file}"
  [[ -f "$FILE" ]] || fail "no such file: ${FILE}"
  say "stopping the API and analytics"
  $COMPOSE stop api analytics
  say "restoring ${FILE}"
  # --clean --if-exists: drop what is there first, so the restore is the dump and
  # nothing else. --no-owner: the roles on this server are what matter.
  $COMPOSE exec -T db pg_restore -U desk -d btc_desk --clean --if-exists --no-owner --single-transaction < "$FILE"
  say "starting the API and analytics"
  $COMPOSE start api analytics
  for _ in $(seq 1 30); do
    if curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health" >/dev/null 2>&1; then
      curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health"; echo; say "healthy"; exit 0
    fi
    sleep 1
  done
  fail "the API did not answer /api/health within 30s"
fi

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/btc_desk-$(date -u +%Y%m%d-%H%M).dump"
$COMPOSE exec -T db pg_dump -U desk -Fc btc_desk > "$OUT"
chmod 600 "$OUT"
say "wrote ${OUT} ($(du -h "$OUT" | cut -f1))"

# Oldest beyond KEEP go.
ls -1t "$OUT_DIR"/btc_desk-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" && say "removed $(basename "$old")"
done
