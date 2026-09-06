#!/usr/bin/env bash
# Harvest yesterday and today into chain.db, then hand the running desk a
# consistent copy. Safe to run repeatedly: the harvester skips days it already
# has, and the copy is a SQLite backup rather than a file grab, so it never
# ships a half-written WAL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TODAY="$(date -u +%F)"
YESTERDAY="$(date -u -d yesterday +%F)"

python3 harvest_chain.py "$YESTERDAY" "$TODAY"

SNAP="$(mktemp -t chain-XXXXXX.db)"
trap 'rm -f "$SNAP"' EXIT
python3 - "$SNAP" <<'PY'
import sqlite3, sys
src = sqlite3.connect('chain.db')
dst = sqlite3.connect(sys.argv[1])
with dst:
    src.backup(dst)
print(dst.execute('SELECT COUNT(*) FROM days').fetchone()[0], 'days')
PY

if docker ps --format '{{.Names}}' | grep -qx btc-desk-api-1; then
    # mktemp gives 0600, and the container runs as an unprivileged user that is
    # not the file's owner. Without this the API answers "unable to open
    # database file" on every request and the healthcheck starts failing.
    # Chowning inside the container is not an option: its root filesystem is
    # read-only and the process has no privileges.
    chmod 644 "$SNAP"
    docker cp "$SNAP" btc-desk-api-1:/srv/data/chain.db
    docker exec btc-desk-api-1 sh -c 'rm -f /srv/data/chain.db-wal /srv/data/chain.db-shm'
    curl -fsS -X POST http://127.0.0.1:8099/api/reload
    echo
else
    echo "btc-desk-api-1 is not running; database updated on disk only" >&2
fi
