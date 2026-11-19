#!/usr/bin/env bash
#
# Proves the newest backup restores (19 Nov 2026). A dump that has never been restored is a hope, not a backup.
#
#   ./deploy/restore-test.sh              -> newest backups/btc_desk-*.dump
#   ./deploy/restore-test.sh FILE.dump    -> that one
#
# The dump goes into a Postgres of its own, made for this and removed after: never the desk's database, and not
# the test database either -- that one keeps its data in memory (test-db.sh, tmpfs), and four gigabytes there would
# be taken from the desk's own memory. This one writes to a scratch directory on disk, and is held to one CPU and
# one gigabyte, so the desk keeps its share even if it ran at the wrong hour. Schedule it at night, monthly:
#
#   0 3 1 * *  /home/ugendran/test-delta/deploy/restore-test.sh >> /home/ugendran/test-delta/restore-test.log 2>&1
#
# Passes when pg_restore finishes without an error, the tables the desk cannot be without have rows, and the
# newest trade is within a day and a half of when the dump was taken. The result goes to Telegram (TG_TOKEN and
# TG_CHAT_ID from app/server/.env) when they are set, pass or fail -- NO_TELEGRAM=1 for a trial -- and to stdout
# always. Nothing is read from Delta.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUPS="${BACKUP_DIR:-$ROOT/backups}"
IMAGE=postgres:17-alpine
NAME="btc-desk-restore-test"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/btc-restore.XXXXXX")"

say()  { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

FILE="${1:-$(ls -1t "$BACKUPS"/btc_desk-*.dump 2>/dev/null | head -1 || true)}"

# Telegram, when the desk's own bot is set up. The token stays in this process: curl reads the URL from stdin.
tell() {
  local env="$ROOT/app/server/.env" token chat
  [[ "${NO_TELEGRAM:-0}" == 1 || ! -f "$env" ]] && return 0
  token="$(grep -E '^TG_TOKEN=' "$env" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
  chat="$(grep -E '^TG_CHAT_ID=' "$env" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
  [[ -n "$token" && -n "$chat" ]] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -fsS -m 15 -K - --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" -o /dev/null || say "telegram not sent"
}

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # The data directory belongs to the container's postgres user: removed from inside a container, then the folder.
  docker run --rm -v "$WORK:/w" "$IMAGE" sh -c 'rm -rf /w/data' >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
fail() {
  say "FAIL: $*"
  tell "❌ BACKUP RESTORE TEST FAILED
$(basename "${FILE:-none}")
$*
Check backups/ and restore-test.log on the server."
  exit 1
}
trap cleanup EXIT

[[ -n "$FILE" && -f "$FILE" ]] || fail "no dump to test in $BACKUPS"
FILE="$(realpath "$FILE")"
TAKEN="$(stat -c %Y "$FILE")"
SIZE="$(du -h "$FILE" | cut -f1)"
say "testing $(basename "$FILE") ($SIZE)"

docker rm -f "$NAME" >/dev/null 2>&1 || true
mkdir -p "$WORK/data"
docker run -d --name "$NAME" --cpus 1 --memory 1g \
  -e POSTGRES_PASSWORD=restore-test -e PGDATA=/var/lib/postgresql/data/pg \
  -v "$WORK/data:/var/lib/postgresql/data" -v "$FILE:/dump:ro" \
  "$IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c maintenance_work_mem=256MB >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -q || fail "the scratch Postgres did not start"
docker exec "$NAME" createdb -U postgres btc_desk

START=$(date +%s)
# --no-owner --no-privileges: the desk's roles are not in a scratch server, and are not what is being tested.
docker exec "$NAME" pg_restore -U postgres -d btc_desk --no-owner --no-privileges --exit-on-error -j 2 /dump \
  || fail "pg_restore stopped with an error"
TOOK=$(( $(date +%s) - START ))

q() { docker exec "$NAME" psql -U postgres -d btc_desk -X -A -t -c "$1"; }
TABLES="$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
for t in trades trade_events strategies broker_accounts settings entry_setups option_snapshots_1m; do
  n="$(q "SELECT count(*) FROM $t" 2>/dev/null || echo missing)"
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] || fail "table $t is ${n:-empty} after the restore"
done
TRADES="$(q 'SELECT count(*) FROM trades')"
NEWEST="$(q 'SELECT coalesce(max(updated_at), 0) / 1000 FROM trades')"
AGE_H=$(( (TAKEN - NEWEST) / 3600 ))
(( AGE_H <= 36 )) || fail "the newest trade is ${AGE_H} h older than the dump: it may not be the desk's latest"

say "PASS: ${TABLES} tables, ${TRADES} trades, newest trade ${AGE_H} h before the dump, restored in ${TOOK} s"
tell "✅ Backup restore test passed
$(basename "$FILE") (${SIZE})
${TABLES} tables · ${TRADES} trades · newest trade ${AGE_H} h before the dump
Restored in ${TOOK} s, into a scratch Postgres, then removed."
