#!/usr/bin/env bash
#
# Build and deploy the BTC Options Desk.
#
#   ./deploy/deploy.sh                 build and run locally
#   ./deploy/deploy.sh --check         validate only, change nothing
#   ./deploy/deploy.sh --host user@ip  build locally, ship, run there
#
# The script refuses to build if a credential is reachable from the build
# context, and rolls back to the previous images if the new ones fail their
# health check.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f ${ROOT}/deploy/docker-compose.yml"
TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M)"
WEB_PORT="${WEB_PORT:-8099}"
REMOTE=""
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --host)  REMOTE="${2:?--host needs user@host}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

say "checking the build context for credentials"
# .dockerignore keeps these out of the image, but a file that exists at all is
# a file that can be copied by mistake later. Say so loudly.
for f in app-ket.txt .env app/server/.env; do
  [[ -e "$ROOT/$f" ]] && printf '    present (excluded from image): %s\n' "$f"
done
if git -C "$ROOT" ls-files --error-unmatch app-ket.txt >/dev/null 2>&1; then
  fail "app-ket.txt is tracked by git. Remove it from the index and rotate that key before deploying."
fi
# a secret that reached a commit is public regardless of what HEAD looks like
if git -C "$ROOT" log --oneline --all -- app-ket.txt 2>/dev/null | grep -q .; then
  fail "app-ket.txt appears in git history. Rotate that key, then purge the history."
fi

say "checking tooling"
command -v docker >/dev/null || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

say "type-checking before we build"
( cd "$ROOT/app/server" && npm ci --silent && npx tsc -p tsconfig.json --noEmit ) || fail "server type-check failed"
( cd "$ROOT/app/web"    && npm ci --silent && npx tsc -b --noEmit )               || fail "web type-check failed"

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "check only; nothing was built or started"
  exit 0
fi

# ---------------------------------------------------------------- build

say "building images at tag ${TAG}"
TAG="$TAG" WEB_PORT="$WEB_PORT" $COMPOSE build

# ---------------------------------------------------------------- ship

if [[ -n "$REMOTE" ]]; then
  say "shipping images to ${REMOTE}"
  docker save "btc-desk-api:${TAG}" "btc-desk-web:${TAG}" | gzip | \
    ssh "$REMOTE" 'gunzip | docker load'
  say "shipping compose files"
  ssh "$REMOTE" 'mkdir -p ~/btc-desk/deploy'
  scp "$ROOT/deploy/docker-compose.yml" "$REMOTE:~/btc-desk/deploy/"
  say "starting on ${REMOTE}"
  ssh "$REMOTE" "cd ~/btc-desk && TAG=${TAG} WEB_PORT=${WEB_PORT} \
    docker compose -f deploy/docker-compose.yml up -d --no-build"
  say "deployed. Point your reverse proxy at port ${WEB_PORT} on that host."
  exit 0
fi

# ---------------------------------------------------------------- run locally

PREV="$(docker inspect -f '{{ index .Config.Labels "tag" }}' btc-desk-api 2>/dev/null || true)"

say "starting"
TAG="$TAG" WEB_PORT="$WEB_PORT" $COMPOSE up -d

say "waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then
    say "healthy after ${i}s"
    curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health"; echo
    say "front end: http://127.0.0.1:${WEB_PORT}/"
    exit 0
  fi
  sleep 1
done

printf '\033[31m==>\033[0m health check failed; last 40 log lines:\n' >&2
$COMPOSE logs --tail 40 >&2
if [[ -n "$PREV" ]]; then
  say "rolling back to ${PREV}"
  TAG="$PREV" WEB_PORT="$WEB_PORT" $COMPOSE up -d
fi
fail "deployment did not come up healthy"
