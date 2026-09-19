#!/usr/bin/env bash
# A throwaway PostgreSQL for the server test suite.
#
#   deploy/test-db.sh up      start it (idempotent) and wait until it answers
#   deploy/test-db.sh down    remove it, data and all
#   deploy/test-db.sh url     print the URL test/env.ts connects to
#
# The suite creates a fresh database per run inside this server and drops it
# afterwards (see app/server/test/env.ts), so nothing here ever holds state
# worth keeping. It listens on 127.0.0.1 only, on a port the desk itself never
# uses, so it cannot be mistaken for the real one.
set -euo pipefail

NAME=btc-desk-test-db
PORT="${TEST_PG_PORT:-5433}"
IMAGE=postgres:17-alpine
URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"

case "${1:-up}" in
  up)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" \
        -e POSTGRES_PASSWORD=postgres \
        -p "127.0.0.1:${PORT}:5432" \
        --tmpfs /var/lib/postgresql/data \
        "$IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
    fi
    for _ in $(seq 1 60); do
      if docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; then
        echo "$URL"
        exit 0
      fi
      sleep 0.5
    done
    echo "test database did not come up" >&2
    docker logs --tail 20 "$NAME" >&2 || true
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: $0 up|down|url" >&2
    exit 2
    ;;
esac
