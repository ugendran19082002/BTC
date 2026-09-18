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
# The address the web port is published on. 0.0.0.0 reaches the internet;
# 127.0.0.1 only a proxy on this host. See docs/NEW-SERVER.md.
WEB_BIND="${WEB_BIND:-0.0.0.0}"
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
  for repo in btc-desk-api btc-desk-web btc-desk-analytics; do
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

# Install only when the dependencies actually changed.
#
# `npm ci` deletes node_modules and reinstalls from the lockfile, which is the
# right thing when the lockfile has moved and pure waste when it has not -- and
# it ran twice on every deploy, whatever had changed. The stamp is the hash of
# the two files that decide what gets installed, so any dependency change still
# forces the full clean install; only a source-only deploy skips it.
ensure_deps() {
  local dir="$1" name="$2" stamp want
  stamp="$dir/node_modules/.deploy-stamp"
  want="$(cat "$dir/package.json" "$dir/package-lock.json" | sha256sum | cut -d' ' -f1)"

  if [[ -d "$dir/node_modules" && -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
    say "$name dependencies unchanged; skipping install"
    return 0
  fi

  say "installing $name dependencies"
  ( cd "$dir" && npm ci ) || return 1
  printf '%s' "$want" > "$stamp"
}

ensure_deps "$ROOT/app/server" server || fail "server install failed"
ensure_deps "$ROOT/app/web"    web    || fail "web install failed"

# The analytics service's test environment, rebuilt only when its requirements
# change -- the same stamp idea as `ensure_deps`. uv when it is installed (fast,
# and needs no system pip), the standard venv otherwise.
ensure_py_deps() {
  local dir="$ROOT/analytics" stamp want
  stamp="$dir/.venv/.deploy-stamp"
  want="$(cat "$dir/requirements.txt" "$dir/requirements-dev.txt" | sha256sum | cut -d' ' -f1)"
  if [[ -x "$dir/.venv/bin/python" && -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
    say "analytics dependencies unchanged; skipping install"
    return 0
  fi
  say "installing analytics dependencies"
  if command -v uv >/dev/null; then
    uv venv "$dir/.venv" >/dev/null && uv pip install --python "$dir/.venv/bin/python" -r "$dir/requirements-dev.txt" >/dev/null || return 1
  else
    python3 -m venv "$dir/.venv" && "$dir/.venv/bin/python" -m pip install -q -r "$dir/requirements-dev.txt" || return 1
  fi
  printf '%s' "$want" > "$stamp"
}
ensure_py_deps || fail "analytics install failed"

# Both suites and both type-checks at once.
#
# Four cores, and the two suites peak around 170 MB and 430 MB, so they fit
# side by side with room to spare. Serially this was the tests of one project
# waiting on the tests of another that shares nothing with it.
#
# Output is captured per job and printed only for whichever fails, so a passing
# deploy stays readable and a failing one still shows everything.
run_jobs() {
  local -n jobs=$1
  local pids=() names=() logs=() rc=0 i
  for i in "${!jobs[@]}"; do
    local log; log="$(mktemp)"
    bash -c "${jobs[$i]}" >"$log" 2>&1 &
    pids+=("$!"); names+=("$i"); logs+=("$log")
  done
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      printf '\n----- %s -----\n' "${names[$i]}" >&2
      cat "${logs[$i]}" >&2
      rc=1
    fi
    rm -f "${logs[$i]}"
  done
  return $rc
}

say "running both test suites"
declare -A TEST_JOBS=(
  ["server tests"]="cd '$ROOT/app/server' && npm test"
  ["web tests"]="cd '$ROOT/app/web' && npm test"
  ["analytics tests"]="cd '$ROOT/analytics' && .venv/bin/python -m pytest -q"
)
run_jobs TEST_JOBS || fail "tests failed"

say "type-checking before we build"
# Call the local binary rather than going through npx: npx will happily decide a
# package is missing and offer to fetch it, which turns a dependency problem into
# a confusing prompt in the middle of a deploy.
declare -A TYPE_JOBS=(
  ["server type-check"]="cd '$ROOT/app/server' && ./node_modules/.bin/tsc -p tsconfig.json --noEmit"
  ["web type-check"]="cd '$ROOT/app/web' && ./node_modules/.bin/tsc -b --noEmit"
)
run_jobs TYPE_JOBS || fail "type-check failed"

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "check only; nothing was built or started"
  exit 0
fi

# ---------------------------------------------------------------- build

say "building images at tag ${TAG}"
TAG="$TAG" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE build
# `latest` follows the newest build, so a bare `docker compose up` can never
# start code from days ago -- which is what `latest` pointed at before this.
for repo in btc-desk-api btc-desk-web btc-desk-analytics; do docker tag "${repo}:${TAG}" "${repo}:latest"; done

# ---------------------------------------------------------------- ship

if [[ -n "$REMOTE" ]]; then
  say "shipping images to ${REMOTE}"
  docker save "btc-desk-api:${TAG}" "btc-desk-web:${TAG}" "btc-desk-analytics:${TAG}" | gzip | \
    ssh "$REMOTE" 'gunzip | docker load'
  say "shipping compose files"
  ssh "$REMOTE" 'mkdir -p ~/btc-desk/deploy'
  scp "$ROOT/deploy/docker-compose.yml" "$REMOTE:~/btc-desk/deploy/"
  say "starting on ${REMOTE}"
  ssh "$REMOTE" "cd ~/btc-desk && TAG=${TAG} WEB_PORT=${WEB_PORT} WEB_BIND=${WEB_BIND} \
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
TAG="$TAG" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE up -d

say "waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then
    say "healthy after ${i}s"
    curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health"; echo
    say "front end: http://127.0.0.1:${WEB_PORT}/"
    # Reported, never required: the desk is healthy without it.
    if $COMPOSE exec -T analytics python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8800/health', timeout=4).status == 200 else 1)" >/dev/null 2>&1; then
      say "analytics: healthy"
    else
      say "analytics: not answering yet -- the cards show the desk's own figures until it does"
    fi
    if [[ $PRUNE -eq 1 ]]; then prune_images; fi
    exit 0
  fi
  sleep 1
done

printf '\033[31m==>\033[0m health check failed; last 40 log lines:\n' >&2
$COMPOSE logs --tail 40 >&2
if [[ -n "$PREV" ]]; then
  say "rolling back to ${PREV}"
  # api and web only: the desk runs without analytics, and a first deploy of it
  # has no previous analytics image to roll back to.
  TAG="$PREV" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE up -d api web
fi
fail "deployment did not come up healthy"
