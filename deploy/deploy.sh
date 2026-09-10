#!/usr/bin/env bash
#
# Build and deploy the BTC Options Desk.
#
#   ./deploy/deploy.sh                 build and run locally
#   ./deploy/deploy.sh --check         validate only, change nothing
#   ./deploy/deploy.sh --host user@ip  build locally, ship, run there
#   ./deploy/deploy.sh --no-prune      deploy, but keep every old image
#
# The script refuses to build if a credential is reachable from the build
# context, and rolls back to the previous images if the new ones fail their
# health check.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f ${ROOT}/deploy/docker-compose.yml"
TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M)"
# An image tagged with a commit must contain exactly that commit. Uncommitted
# changes get a tag of their own, so a rollback can never land on code that is
# not in git under the name it claims.
if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
  TAG="${TAG}-dirty-$(date -u +%H%M%S)"
fi
# How many recent releases of each image to keep, besides the running one and
# the one it replaced.
KEEP_IMAGES="${KEEP_IMAGES:-3}"
PRUNE=1
WEB_PORT="${WEB_PORT:-8099}"
REMOTE=""
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --host)  REMOTE="${2:?--host needs user@host}"; shift 2 ;;
    --no-prune) PRUNE=0; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Old images, removed the safe way.
#
# Not `docker image prune -a`. That deletes every image no container is using,
# which includes the previous release -- the one a failed deploy rolls back to --
# and every image of every other project on the host. Instead, per repository:
# keep the running tag, the tag it replaced, and the newest KEEP_IMAGES; remove
# the rest. Then dangling layers, and build cache older than three days, which is
# most of the space and none of the build speed.
prune_images() {
  local repo tag keep removed=0
  for repo in btc-desk-api btc-desk-web; do
    keep="$(docker images "$repo" --format '{{.CreatedAt}}|{{.Tag}}' \
      | sort -r | cut -d'|' -f2 | grep -vx 'latest' | head -n "$KEEP_IMAGES" || true)"
    while IFS= read -r tag; do
      [[ -z "$tag" || "$tag" == "latest" || "$tag" == "$TAG" || "$tag" == "${PREV:-}" ]] && continue
      grep -qx -- "$tag" <<<"$keep" && continue
      # rmi without -f refuses an image a container still uses, which is the point
      if docker rmi "${repo}:${tag}" >/dev/null 2>&1; then removed=$((removed + 1)); fi
    done < <(docker images "$repo" --format '{{.Tag}}')
  done
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter 'until=72h' >/dev/null 2>&1 || true
  say "removed ${removed} old image tags; kept ${TAG}, ${PREV:-no previous}, and the newest ${KEEP_IMAGES} of each"
  say "docker disk now: $(docker system df --format '{{.Type}}={{.Size}}' | tr '\n' ' ')"
}

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

say "running the test suite"
( cd "$ROOT/app/server" && npm ci && npm test ) || fail "server tests failed"
( cd "$ROOT/app/web"    && npm ci && npm test ) || fail "web tests failed"

say "type-checking before we build"
# Call the local binary rather than going through npx: npx will happily decide a
# package is missing and offer to fetch it, which turns a dependency problem into
# a confusing prompt in the middle of a deploy.
( cd "$ROOT/app/server" && ./node_modules/.bin/tsc -p tsconfig.json --noEmit ) \
  || fail "server type-check failed"
( cd "$ROOT/app/web"    && ./node_modules/.bin/tsc -b --noEmit ) \
  || fail "web type-check failed"

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "check only; nothing was built or started"
  exit 0
fi

# ---------------------------------------------------------------- build

say "building images at tag ${TAG}"
TAG="$TAG" WEB_PORT="$WEB_PORT" $COMPOSE build
# `latest` follows the newest build, so a bare `docker compose up` can never
# start code from days ago -- which is what `latest` pointed at before this.
for repo in btc-desk-api btc-desk-web; do docker tag "${repo}:${TAG}" "${repo}:latest"; done

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

# The tag the running API was started from: what a failed deploy rolls back to.
#
# Read from the running container's image. The old lookup asked a container
# named `btc-desk-api` for a `tag` label; compose names it btc-desk-api-1 and
# sets no such label, so PREV was always empty and rollback had never run once.
PREV=""
PREV_ID="$($COMPOSE ps -q api 2>/dev/null || true)"
if [[ -n "$PREV_ID" ]]; then
  PREV="$(docker inspect -f '{{.Config.Image}}' "$PREV_ID" 2>/dev/null | sed -n 's/^btc-desk-api://p' || true)"
fi
[[ "$PREV" == "$TAG" ]] && PREV=""
say "running now: ${PREV:-nothing}"

say "starting"
TAG="$TAG" WEB_PORT="$WEB_PORT" $COMPOSE up -d

say "waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then
    say "healthy after ${i}s"
    curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health"; echo
    say "front end: http://127.0.0.1:${WEB_PORT}/"
    if [[ $PRUNE -eq 1 ]]; then prune_images; fi
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
