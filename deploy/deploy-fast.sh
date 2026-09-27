#!/usr/bin/env bash
#
# Fast Direct Deploy for BTC Options Desk (Skips Test Suites).
#
# Usage:
#   ./deploy/deploy-fast.sh                 build and run locally without tests
#   ./deploy/deploy-fast.sh --host user@ip  build locally, ship, run there
#   ./deploy/deploy-fast.sh --no-prune      deploy, but keep every old image
#   ./deploy/deploy-fast.sh --check         validate preflight only
#   ./deploy/deploy-fast.sh --help          show help
#
# Bypasses test database setup, unit/e2e tests, and development installs
# for an immediate, fast production build and restart. It still validates
# configuration and credentials, performs Docker multi-stage builds, and
# verifies post-deployment health checks with automatic rollback if unhealthy.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f ${ROOT}/deploy/docker-compose.yml"
TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M)"

if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
  TAG="${TAG}-dirty-$(date -u +%H%M%S)"
fi

KEEP_IMAGES="${KEEP_IMAGES:-3}"
PRUNE=1
WEB_PORT="${WEB_PORT:-8099}"
WEB_BIND="${WEB_BIND:-172.17.0.1}"
DESK_HOST="$WEB_BIND"; [[ "$DESK_HOST" == "0.0.0.0" ]] && DESK_HOST=127.0.0.1
REMOTE=""
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --host)  REMOTE="${2:?--host needs user@host}"; shift 2 ;;
    --no-prune) PRUNE=0; shift ;;
    --port)  WEB_PORT="${2:?--port needs port number}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

tag_latest() {
  local want="$1" repo
  for repo in btc-desk-api btc-desk-web btc-desk-analytics; do
    docker image inspect "${repo}:${want}" >/dev/null 2>&1 || continue
    docker tag "${repo}:${want}" "${repo}:latest"
  done
}

prune_images() {
  local repo tag keep removed=0
  for repo in btc-desk-api btc-desk-web btc-desk-analytics; do
    keep="$(docker images "$repo" --format '{{.CreatedAt}}|{{.Tag}}' \
      | sort -r | cut -d'|' -f2 | grep -vx 'latest' | head -n "$KEEP_IMAGES" || true)"
    while IFS= read -r tag; do
      [[ -z "$tag" || "$tag" == "latest" || "$tag" == "$TAG" || "$tag" == "${PREV:-}" ]] && continue
      grep -qx -- "$tag" <<<"$keep" && continue
      if docker rmi "${repo}:${tag}" >/dev/null 2>&1; then removed=$((removed + 1)); fi
    done < <(docker images "$repo" --format '{{.Tag}}')
  done
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter 'until=72h' >/dev/null 2>&1 || true
  say "removed ${removed} old image tags; kept ${TAG}, ${PREV:-no previous}, and the newest ${KEEP_IMAGES} of each"
}

# ---------------------------------------------------------------- preflight
say "checking the build context for credentials"
for f in app-ket.txt .env app/server/.env deploy/.env; do
  [[ -e "$ROOT/$f" ]] && printf '    present (excluded from image): %s\n' "$f"
done
if git -C "$ROOT" ls-files --error-unmatch deploy/.env >/dev/null 2>&1; then
  fail "deploy/.env is tracked by git. Remove it from the index and change the database password."
fi
[[ -f "$ROOT/deploy/.env" ]] && grep -qE '^POSTGRES_PASSWORD=.+' "$ROOT/deploy/.env" \
  || fail "deploy/.env must set POSTGRES_PASSWORD (copy deploy/.env.example; openssl rand -base64 24)"
if git -C "$ROOT" ls-files --error-unmatch app-ket.txt >/dev/null 2>&1; then
  fail "app-ket.txt is tracked by git. Remove it from the index and rotate that key before deploying."
fi
if git -C "$ROOT" log --oneline --all -- app-ket.txt 2>/dev/null | grep -q .; then
  fail "app-ket.txt appears in git history. Rotate that key, then purge the history."
fi

say "checking tooling"
command -v docker >/dev/null || fail "docker is not installed"
command -v curl >/dev/null || fail "curl is not installed; the health check needs it"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "check only; preflight passed, nothing was built or started"
  exit 0
fi

# ---------------------------------------------------------------- build (fast)
say "skipping test suites: building images directly at tag ${TAG}"
TAG="$TAG" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE build

# ---------------------------------------------------------------- ship
if [[ -n "$REMOTE" ]]; then
  say "shipping images to ${REMOTE}"
  docker save "btc-desk-api:${TAG}" "btc-desk-web:${TAG}" "btc-desk-analytics:${TAG}" | gzip | \
    ssh "$REMOTE" 'gunzip | docker load'
  say "shipping compose files"
  ssh "$REMOTE" 'mkdir -p ~/btc-desk/deploy'
  scp "$ROOT/deploy/docker-compose.yml" "$REMOTE:~/btc-desk/deploy/"
  scp "$ROOT/deploy/.env" "$REMOTE:~/btc-desk/deploy/.env"
  ssh "$REMOTE" 'chmod 600 ~/btc-desk/deploy/.env'
  say "starting on ${REMOTE}"
  ssh "$REMOTE" "cd ~/btc-desk && TAG=${TAG} WEB_PORT=${WEB_PORT} WEB_BIND=${WEB_BIND} \
    docker compose -f deploy/docker-compose.yml up -d --no-build"
  tag_latest "$TAG"
  say "deployed. Point your reverse proxy at port ${WEB_PORT} on that host."
  exit 0
fi

# ---------------------------------------------------------------- run locally
PREV=""
PREV_ID="$($COMPOSE ps -q api 2>/dev/null || true)"
if [[ -n "$PREV_ID" ]]; then
  PREV="$(docker inspect -f '{{.Config.Image}}' "$PREV_ID" 2>/dev/null | sed -n 's/^btc-desk-api://p' || true)"
fi
[[ "$PREV" == "$TAG" ]] && PREV=""
say "running now: ${PREV:-nothing}"

say "starting updated containers"
TAG="$TAG" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE up -d

say "waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health" >/dev/null 2>&1; then
    say "healthy after ${i}s"
    curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health"; echo
    say "front end: http://${DESK_HOST}:${WEB_PORT}/"
    if $COMPOSE exec -T analytics python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8800/health', timeout=4).status == 200 else 1)" >/dev/null 2>&1; then
      say "analytics: healthy"
    else
      say "analytics: not answering yet -- the cards show the desk's own figures until it does"
    fi
    tag_latest "$TAG"
    if [[ $PRUNE -eq 1 ]]; then prune_images; fi
    say "fast deployment complete!"
    exit 0
  fi
  sleep 1
done

printf '\033[31m==>\033[0m health check failed; last 40 log lines:\n' >&2
$COMPOSE logs --tail 40 >&2
if [[ -n "$PREV" ]]; then
  say "rolling back to ${PREV}"
  TAG="$PREV" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE up -d api web
  tag_latest "$PREV"
fi
fail "deployment did not come up healthy"
