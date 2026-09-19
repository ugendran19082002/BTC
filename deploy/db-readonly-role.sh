#!/usr/bin/env bash
#
# The read-only database account, `desk_ro`, for Adminer and anyone looking.
#
#   ./deploy/db-readonly-role.sh        create it, or reset its password, from deploy/.env
#
# SELECT on every table in every desk schema -- including tables created later,
# through default privileges -- and nothing else. Every session it opens is
# read-only by default and gives up after 30 seconds, so a careless query in a
# console cannot hold a lock the trading engine is waiting on.
#
# Idempotent: run it after the first deploy, and again whenever the password in
# deploy/.env changes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/.env}"
COMPOSE="docker compose --env-file ${ENV_FILE} -f ${ROOT}/deploy/docker-compose.yml"

fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || fail "no ${ENV_FILE}"
PW="$(sed -n 's/^DB_READONLY_PASSWORD=//p' "$ENV_FILE")"
[[ ${#PW} -ge 16 ]] || fail "set DB_READONLY_PASSWORD in deploy/.env (openssl rand -base64 24)"
$COMPOSE ps --status running -q db 2>/dev/null | grep -q . || fail "the db container is not running"

# The password goes in as a psql variable, never on a command line `ps` can see.
$COMPOSE exec -T db psql -U desk -d btc_desk -v ON_ERROR_STOP=1 -v pw="$PW" <<'SQL'
SELECT format('CREATE ROLE desk_ro LOGIN PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_ro') \gexec
SELECT format('ALTER ROLE desk_ro LOGIN PASSWORD %L', :'pw') \gexec
ALTER ROLE desk_ro SET default_transaction_read_only = on;
ALTER ROLE desk_ro SET statement_timeout = '30s';
ALTER ROLE desk_ro SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE desk_ro CONNECTION LIMIT 5;
GRANT CONNECT ON DATABASE btc_desk TO desk_ro;
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT unnest(ARRAY['public','trading','strategy','auth','errors','market','analytics']) LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO desk_ro', s);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO desk_ro', s);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE desk IN SCHEMA %I GRANT SELECT ON TABLES TO desk_ro', s);
    END IF;
  END LOOP;
END $$;
-- The sign-in secrets are sealed, but a console has no business reading them.
REVOKE SELECT ON auth.user, auth.sessions, auth.recovery_codes FROM desk_ro;
SQL
echo "desk_ro ready: read-only, 30 s statement limit, no access to the sign-in secrets"
