#!/usr/bin/env bash
#
# Build and deploy the BTC Options Desk.
#
#   ./deploy/deploy.sh                 build and run locally
#   ./deploy/deploy.sh --no-test       fast deploy without running test suites
#   ./deploy/deploy.sh --check         validate only, change nothing
#   ./deploy/deploy.sh --host user@ip  build locally, ship, run there
#   ./deploy/deploy.sh --no-prune      deploy, but keep every old image
#   ./deploy/deploy.sh --no-backup     deploy without the database backup first
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
# The address the web port is published on. The docker bridge (the default)
# reaches a containerised edge proxy and not the internet; 127.0.0.1 suits a
# proxy on the host; 0.0.0.0 is the internet. See docs/NEW-SERVER.md.
WEB_BIND="${WEB_BIND:-172.17.0.1}"
# Where this script (and its health check) reaches the desk.
DESK_HOST="$WEB_BIND"; [[ "$DESK_HOST" == "0.0.0.0" ]] && DESK_HOST=127.0.0.1
REMOTE=""
CHECK_ONLY=0
NO_TEST=0
BACKUP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --no-test|--fast|-f) NO_TEST=1; shift ;;
    --host)  REMOTE="${2:?--host needs user@host}"; shift 2 ;;
    --no-prune) PRUNE=0; shift ;;
    --no-backup) BACKUP=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
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
for f in app-ket.txt .env app/server/.env deploy/.env; do
  [[ -e "$ROOT/$f" ]] && printf '    present (excluded from image): %s\n' "$f"
done
if git -C "$ROOT" ls-files --error-unmatch deploy/.env >/dev/null 2>&1; then
  fail "deploy/.env is tracked by git. Remove it from the index and change the database password."
fi
# The compose file will not start without it, and a deploy that gets as far as
# `up` before finding that out has already stopped the old containers.
[[ -f "$ROOT/deploy/.env" ]] && grep -qE '^POSTGRES_PASSWORD=.+' "$ROOT/deploy/.env" \
  || fail "deploy/.env must set POSTGRES_PASSWORD (copy deploy/.env.example; openssl rand -base64 24)"
if git -C "$ROOT" ls-files --error-unmatch app-ket.txt >/dev/null 2>&1; then
  fail "app-ket.txt is tracked by git. Remove it from the index and rotate that key before deploying."
fi
# a secret that reached a commit is public regardless of what HEAD looks like
if git -C "$ROOT" log --oneline --all -- app-ket.txt 2>/dev/null | grep -q .; then
  fail "app-ket.txt appears in git history. Rotate that key, then purge the history."
fi

say "checking tooling"
command -v docker >/dev/null || fail "docker is not installed"
# The health gate is a curl call. Without curl every probe fails silently, the
# loop runs its full thirty seconds, and a perfectly good deploy is rolled back
# -- a missing tool reported as a broken build.
command -v curl >/dev/null || fail "curl is not installed; the health check needs it"
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

if [[ $NO_TEST -ne 1 ]]; then
  ensure_deps "$ROOT/app/server" server || fail "server install failed"
  ensure_deps "$ROOT/app/web"    web    || fail "web install failed"
fi

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

if [[ $NO_TEST -eq 1 ]]; then
  say "skipping test suites and host type-checks (--no-test active)"
else
  # The server suite needs a PostgreSQL to talk to: a throwaway one, on a port
  # the desk never uses, gone again afterwards.
  say "starting the test database"
  TEST_PG_URL="$("$ROOT/deploy/test-db.sh" up)" || fail "could not start the test database"
  trap '"$ROOT/deploy/test-db.sh" down' EXIT

  say "running the test suites"
  declare -A TEST_JOBS=(
    ["server tests"]="cd '$ROOT/app/server' && TEST_PG_URL='$TEST_PG_URL' npm test"
    ["web tests"]="cd '$ROOT/app/web' && npm test"
  )
  run_jobs TEST_JOBS || fail "tests failed"
  "$ROOT/deploy/test-db.sh" down
  trap - EXIT

  say "type-checking before we build"
  # Call the local binary rather than going through npx: npx will happily decide a
  # package is missing and offer to fetch it, which turns a dependency problem into
  # a confusing prompt in the middle of a deploy.
  declare -A TYPE_JOBS=(
    ["server type-check"]="cd '$ROOT/app/server' && ./node_modules/.bin/tsc -p tsconfig.json --noEmit"
    ["web type-check"]="cd '$ROOT/app/web' && ./node_modules/.bin/tsc -b --noEmit"
  )
  run_jobs TYPE_JOBS || fail "type-check failed"
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "check only; nothing was built or started"
  exit 0
fi

# ---------------------------------------------------------------- build

say "building images at tag ${TAG}"
TAG="$TAG" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE build

# `latest` follows the newest build that actually came up, so a bare
# `docker compose up` can never start code from days ago -- which is what
# `latest` pointed at before it existed.
#
# It is moved *after* the health gate on purpose. Tagging it straight after the
# build meant a deploy that failed its health check left `latest` on the broken
# image: the rollback put the previous tag back into the running containers, but
# the next bare `docker compose up` still started the build that had just been
# rejected. `latest` now means "the newest build seen healthy", which is the only
# reading that makes it safe to start from.
tag_latest() {
  local want="$1" repo
  for repo in btc-desk-api btc-desk-web; do
    # A rollback target may predate one of the three images; skip what is absent
    # rather than abort a rollback over a tag that was never built.
    docker image inspect "${repo}:${want}" >/dev/null 2>&1 || continue
    docker tag "${repo}:${want}" "${repo}:latest"
  done
}

# ---------------------------------------------------------------- ship

if [[ -n "$REMOTE" ]]; then
  say "shipping images to ${REMOTE}"
  docker save "btc-desk-api:${TAG}" "btc-desk-web:${TAG}" | gzip | \
    ssh "$REMOTE" 'gunzip | docker load'
  say "shipping compose files"
  ssh "$REMOTE" 'mkdir -p ~/btc-desk/deploy'
  scp "$ROOT/deploy/docker-compose.yml" "$REMOTE:~/btc-desk/deploy/"
  # The database password travels with the compose file it belongs to, 0600.
  scp "$ROOT/deploy/.env" "$REMOTE:~/btc-desk/deploy/.env"
  ssh "$REMOTE" 'chmod 600 ~/btc-desk/deploy/.env'
  if [[ $BACKUP -eq 1 ]]; then
    scp "$ROOT/deploy/backup-db.sh" "$REMOTE:~/btc-desk/deploy/"
    say "backing up the database on ${REMOTE} first"
    ssh "$REMOTE" 'cd ~/btc-desk && if docker compose -f deploy/docker-compose.yml ps --status running -q db 2>/dev/null | grep -q .; then ./deploy/backup-db.sh; else echo "no database running yet: nothing to back up"; fi' \
      || fail "backup on ${REMOTE} failed; nothing was started"
  fi
  say "starting on ${REMOTE}"
  ssh "$REMOTE" "cd ~/btc-desk && TAG=${TAG} WEB_PORT=${WEB_PORT} WEB_BIND=${WEB_BIND} \
    docker compose -f deploy/docker-compose.yml up -d --no-build"
  # Shipped and started there; nothing local was health-checked, but the images
  # are known good enough to have started, so local `latest` may follow them.
  tag_latest "$TAG"
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

# A database backup before anything new starts: a deploy may carry migrations,
# and a migration cannot be taken back without one (restore with
# `deploy/backup-db.sh --restore FILE`). Skipped on a first deploy, when there
# is no database yet, and with --no-backup.
if [[ $BACKUP -eq 1 ]] && $COMPOSE ps --status running -q db 2>/dev/null | grep -q .; then
  say "backing up the database first"
  "$ROOT/deploy/backup-db.sh" || fail "backup failed; nothing was started"
fi

say "starting"
TAG="$TAG" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE up -d

say "waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health" >/dev/null 2>&1; then
    say "healthy after ${i}s"
    curl -fsS "http://${DESK_HOST}:${WEB_PORT}/api/health"; echo
    say "front end: http://${DESK_HOST}:${WEB_PORT}/"
    # Reported, never required: the desk is healthy without it.
    # Healthy: this is now the build a bare `docker compose up` should start.
    tag_latest "$TAG"
    if [[ $PRUNE -eq 1 ]]; then prune_images; fi
    exit 0
  fi
  sleep 1
done

printf '\033[31m==>\033[0m health check failed; last 40 log lines:\n' >&2
$COMPOSE logs --tail 40 >&2
if [[ -n "$PREV" ]]; then
  say "rolling back to ${PREV}"
  # api and web only. The database is never rolled back -- its image is not
  # ours, and its data is the point; the backup taken before this deploy is
  # there if a migration has to be undone.
  TAG="$PREV" WEB_PORT="$WEB_PORT" WEB_BIND="$WEB_BIND" $COMPOSE up -d api web
  # And `latest` goes back with them, or the next bare `up` starts the build
  # that was just rolled back.
  tag_latest "$PREV"
fi
fail "deployment did not come up healthy"
