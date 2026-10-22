# shellcheck shell=bash
#
# The api handed over without a gap (22 Oct 2026): sourced by deploy.sh and deploy-fast.sh.
#
# `docker compose up -d` stops the running api and then starts the new one: about seven seconds in which no process
# watched a stop -- the container made, Node up, the socket opened. With the desk lock (app/server/src/db/desk-lock.ts)
# the new one can start first: it opens the board and waits at the lock as a standby while the old one still trades;
# the old one is stopped, the standby is handed the lock the moment it is free and recovers every open trade from Delta
# before acting. What is left of the gap is the stop itself and the boot after the lock.
#
# Only when the running api holds the lock -- an older build without it would go on trading beside the new one, so
# that hand-over is done the plain way, stop then start. The new one not healthy in time: it is removed and the old one
# started again, which takes the lock back.
#
# Needs: $COMPOSE (the compose command with its file), `say`, and TAG / WEB_PORT / WEB_BIND in the environment.

HANDOVER_STANDBY_S="${HANDOVER_STANDBY_S:-120}"
HANDOVER_HEALTHY_S="${HANDOVER_HEALTHY_S:-90}"

# Whether a container's log says it. Read whole, not piped to `grep -q`: under `pipefail` a grep that stops at its first
# match leaves `docker logs` killed by SIGPIPE, and a line that is there would read as missing.
handover_said() {
  local out
  out="$(docker logs "$1" 2>&1 || true)"
  [[ "$out" == *"$2"* ]]
}

handover_healthy() {
  docker exec "$1" node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

# 0: the new api is up and the old one gone (or there was nothing to hand over). 1: nothing changed, or rolled back.
handover_up() {
  local old new i t0
  old="$($COMPOSE ps -q api 2>/dev/null | head -1 || true)"
  if [[ -z "$old" ]] || ! handover_said "$old" 'desk lock held'; then
    say "hand-over: no api holding the desk lock is running -- starting the plain way, stop then start"
    $COMPOSE up -d
    return 0
  fi

  say "hand-over: a standby api beside the running one (${old:0:12})"
  $COMPOSE up -d --no-deps --no-recreate --scale api=2 api
  new="$($COMPOSE ps -q api | grep -v "^${old}" | head -1 || true)"
  if [[ -z "$new" ]]; then
    say "hand-over: no standby was started -- the running api is untouched"
    return 1
  fi
  for ((i = 0; i < HANDOVER_STANDBY_S; i++)); do
    handover_said "$new" 'waiting as a standby' && break
    [[ "$(docker inspect -f '{{.State.Running}}' "$new" 2>/dev/null)" == "true" ]] || break
    sleep 1
  done
  if ! handover_said "$new" 'waiting as a standby'; then
    say "hand-over: the new api never reached the lock -- removed; the running api is untouched. Its last lines:"
    docker logs --tail 20 "$new" >&2 || true
    docker rm -f "$new" >/dev/null
    return 1
  fi

  # Its board open before it is handed the desk: the first look after the hand-over is on a board seconds fresh.
  for ((i = 0; i < 15; i++)); do
    handover_said "$new" 'ticker socket open' && break
    sleep 1
  done
  say "hand-over: standby waiting at the lock$(handover_said "$new" 'ticker socket open' && echo ', its board open'); stopping the running api"
  t0="$(date +%s%N)"
  docker stop -t 30 "$old" >/dev/null
  for ((i = 0; i < HANDOVER_HEALTHY_S * 4; i++)); do
    if handover_healthy "$new"; then
      say "hand-over: the new api is healthy $(( ($(date +%s%N) - t0) / 1000000 )) ms after the old one was told to stop"
      docker rm "$old" >/dev/null
      # The rest -- web on its new image -- with the api as it now is: same configuration, so not made again.
      $COMPOSE up -d
      return 0
    fi
    sleep 0.25
  done

  say "hand-over: the new api did not come up healthy -- removed, and the old one started again"
  docker logs --tail 40 "$new" >&2 || true
  docker rm -f "$new" >/dev/null
  docker start "$old" >/dev/null
  return 1
}
