#!/usr/bin/env bash
#
# Load the data packed by deploy/export-data.sh into this server's desk.
#
#   ./deploy/import-data.sh /tmp/btc-desk-data-20260914-1430.tar.gz
#
# Run AFTER the first ./deploy/deploy.sh here, so the volume and the database
# exist. The API is stopped while the data goes in -- a database swapped under
# a running process is a corrupted database -- and started again after, then
# health-checked.
#
# What goes in is what the tarball holds: chain.db always, placed on the data
# volume and at the repository root, where refresh.sh reads it from each
# evening; and btc_desk.dump when the export included it (a move, not a paper
# copy), restored over this server's database with pg_restore.
#
# The sign-in tables in the dump open only under the same DESK_SESSION_SECRET.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f ${ROOT}/deploy/docker-compose.yml"
VOLUME="${DATA_VOLUME:-btc-desk_data}"
WEB_PORT="${WEB_PORT:-8099}"
DESK_HOST="${DESK_HOST:-172.17.0.1}"
TARBALL="${1:?usage: import-data.sh <btc-desk-data-*.tar.gz>}"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$TARBALL" ]] || fail "no such file: ${TARBALL}"
command -v docker >/dev/null || fail "docker is not installed"
docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || fail "volume ${VOLUME} does not exist: run ./deploy/deploy.sh once first"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -C "$WORK" -xzf "$TARBALL"
FILES="$(cd "$WORK" && ls *.db *.dump 2>/dev/null || true)"
[[ -n "$FILES" ]] || fail "the tarball holds no .db or .dump files"
say "found: $(echo $FILES)"

# Each file must at least be what its name says before it replaces anything.
for f in $FILES; do
  case "$f" in
    *.db)   head -c 16 "$WORK/$f" | grep -q 'SQLite format 3' || fail "${f} is not a SQLite database" ;;
    *.dump) head -c 5  "$WORK/$f" | grep -q 'PGDMP'           || fail "${f} is not a pg_dump archive" ;;
  esac
done

# The API, if it is running here, is stopped for the swap. `stop`, not `down`:
# the container and its volume stay, only the process ends.
RUNNING=0
if $COMPOSE ps --status running -q api 2>/dev/null | grep -q .; then
  RUNNING=1
  say "stopping the API"
  $COMPOSE stop api
fi

if ls "$WORK"/*.db >/dev/null 2>&1; then
  say "placing the files in volume ${VOLUME}"
  docker run --rm \
    -v "${VOLUME}:/srv/data" \
    -v "${WORK}:/in:ro" \
    alpine sh -c '
      set -e
      for f in /in/*.db; do
        n=$(basename "$f")
        cp "$f" "/srv/data/$n"
        rm -f "/srv/data/$n-wal" "/srv/data/$n-shm"
        chown 1000:1000 "/srv/data/$n"
        chmod 644 "/srv/data/$n"
      done
      ls -la /srv/data/*.db
    '
fi

if [[ -f "$WORK/btc_desk.dump" ]]; then
  say "restoring the database"
  $COMPOSE ps --status running -q db 2>/dev/null | grep -q . || fail "the db container is not running: run ./deploy/deploy.sh once first"
  $COMPOSE exec -T db pg_restore -U desk -d btc_desk --clean --if-exists --no-owner --single-transaction < "$WORK/btc_desk.dump"
fi

if [[ -f "$WORK/chain.db" ]]; then
  cp "$WORK/chain.db" "$ROOT/chain.db"
  say "chain.db also placed at ${ROOT}/chain.db for refresh.sh"
fi

if [[ $RUNNING -eq 1 ]]; then
  say "starting the API"
  $COMPOSE start api
  for _ in $(seq 1 30); do
    if curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health" 2>/dev/null; then
      echo; say "healthy"; exit 0
    fi
    sleep 1
  done
  fail "the API did not answer /api/health within 30s: docker logs btc-desk-api-1"
fi
say "done; the API was not running, so nothing was restarted"
