#!/usr/bin/env bash
#
# Pack the desk's databases for another server.
#
#   ./deploy/export-data.sh            -> data-export/btc-desk-data-<utc stamp>.tar.gz
#   ./deploy/export-data.sh --chain    -> chain.db only (a paper copy needs nothing else)
#
# Consistent copies, taken with SQLite's backup API while the desk keeps
# running -- never `cp` of a WAL-mode file, which ships a half-written journal
# and opens on the other side missing its last minutes. Nothing is stopped
# here; whether the old desk should be *trading* while its journal is copied is
# the question in docs/NEW-SERVER.md §0, not this script's.
#
# Read from the Docker volume through a throwaway container, because the
# volume's directory on the host is root-only and the API's own filesystem is
# read-only. Then: scp the file, and run deploy/import-data.sh over there.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOLUME="${DATA_VOLUME:-btc-desk_data}"
OUT_DIR="$ROOT/data-export"
STAMP="$(date -u +%Y%m%d-%H%M)"
CHAIN_ONLY=0
[[ "${1:-}" == "--chain" ]] && CHAIN_ONLY=1

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker is not installed"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || fail "volume ${VOLUME} does not exist; has the desk been deployed here?"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d "$OUT_DIR/.work-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
chmod 777 "$WORK"   # the container writes as an unprivileged user

FILES="chain.db"
[[ $CHAIN_ONLY -eq 0 ]] && FILES="chain.db trades.db auth.db"

say "snapshotting ${FILES} from volume ${VOLUME}"
docker run --rm -i \
  -v "${VOLUME}:/srv/data:ro" \
  -v "${WORK}:/out" \
  -e FILES="$FILES" \
  python:3-alpine python - <<'PY'
import os, sqlite3, sys
for name in os.environ['FILES'].split():
    path = f'/srv/data/{name}'
    if not os.path.exists(path):
        print(f'    {name}: not present, skipped'); continue
    src = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    dst = sqlite3.connect(f'/out/{name}')
    with dst:
        src.backup(dst)
    src.close(); dst.close()
    n = ''
    if name == 'chain.db':
        n = sqlite3.connect(f'/out/{name}').execute('SELECT COUNT(*) FROM days').fetchone()[0]
        n = f', {n} days'
    if name == 'trades.db':
        c = sqlite3.connect(f'/out/{name}')
        try:
            n = f", {c.execute('SELECT COUNT(*) FROM trades').fetchone()[0]} trades"
        except sqlite3.Error:
            n = ''
    print(f'    {name}: {os.path.getsize(f"/out/{name}") // 1024} KB{n}')
PY

# The desk's own .env is NOT included: it holds the exchange key and the
# session secret, and a tarball is a file that gets copied about. Carry it by
# hand, and read docs/NEW-SERVER.md §3 before reusing any key.
OUT="$OUT_DIR/btc-desk-data-${STAMP}.tar.gz"
tar -C "$WORK" -czf "$OUT" .
chmod 600 "$OUT"
say "wrote ${OUT} ($(du -h "$OUT" | cut -f1))"
say "next, on this machine:   scp ${OUT} user@newserver:/tmp/"
say "then, on the new server: ./deploy/import-data.sh /tmp/$(basename "$OUT")"
