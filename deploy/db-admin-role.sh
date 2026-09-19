#!/usr/bin/env bash
#
# A named admin login for a person, separate from the `desk` account the
# application uses.
#
#   ./deploy/db-admin-role.sh      create it, or reset its password, from deploy/.env
#
# DB_ADMIN_USER / DB_ADMIN_PASSWORD in deploy/.env. The role is a member of
# `desk`, which owns every table, so it can do everything the desk can:
# read, write, alter, create, drop, in every schema. It is NOT a superuser --
# that would add running programs on the database server (COPY ... PROGRAM),
# which no console needs.
#
# Its own name, so the database log and pg_stat_activity say who did what,
# and it can be disabled without touching the application's password.
# Run again after a restore onto a new server: pg_dump does not carry roles.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/.env}"
COMPOSE="docker compose --env-file ${ENV_FILE} -f ${ROOT}/deploy/docker-compose.yml"

fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || fail "no ${ENV_FILE}"
USER_="$(sed -n 's/^DB_ADMIN_USER=//p' "$ENV_FILE")"
PW="$(sed -n 's/^DB_ADMIN_PASSWORD=//p' "$ENV_FILE")"
[[ "$USER_" =~ ^[a-z_][a-z0-9_]{1,30}$ ]] || fail "set DB_ADMIN_USER in deploy/.env (lower-case letters, digits, _)"
[[ ${#PW} -ge 8 ]] || fail "set DB_ADMIN_PASSWORD in deploy/.env (8 characters or more)"
[[ "$USER_" != "desk" && "$USER_" != "desk_ro" ]] || fail "DB_ADMIN_USER must not be one of the desk's own roles"
$COMPOSE ps --status running -q db 2>/dev/null | grep -q . || fail "the db container is not running"

# Name and password go in as psql variables over stdin, never on a command line.
$COMPOSE exec -T db psql -U desk -d btc_desk -v ON_ERROR_STOP=1 -v u="$USER_" -v pw="$PW" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'u')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION INHERIT PASSWORD %L', :'u', :'pw') \gexec
SELECT format('ALTER ROLE %I CONNECTION LIMIT 5', :'u') \gexec
-- Full access to everything the desk owns, now and later.
SELECT format('GRANT desk TO %I', :'u') \gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE btc_desk TO %I', :'u') \gexec
-- Whatever it creates belongs to desk, so the application keeps owning its schema.
SELECT format('ALTER ROLE %I SET role = desk', :'u') \gexec
-- Open on the trading tables, and find every desk table without a schema prefix
-- (Adminer shows one schema at a time; this one is where it starts).
SELECT format('ALTER ROLE %I SET search_path = trading, strategy, auth, errors, market, analytics, public', :'u') \gexec
SQL
echo "${USER_} ready: full access to btc_desk (member of desk), not a superuser"
