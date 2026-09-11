# Deployment — delta.thannigo.in

**Live**: https://delta.thannigo.in

This is the state as actually deployed, not a plan.

## What runs where

`204.168.233.179` **is this machine**. `delta.thannigo.in` resolves to it, and
the repo lives on it at `/home/agent/test-delta`. `deploy.sh --host` therefore
loops back over SSH to localhost, which works but is pointless — use the plain
form.

```
browser ──443──> banknifty-proxy-1 ──> host.docker.internal:8099 ──> btc-desk-web  (nginx:1.27-alpine, static build)
                 (nginx 1.27-alpine)                                        └──────> btc-desk-api  (Fastify, no host port)
                                                                                            └────> /srv/data/chain.db  (volume)
```

Ports 80 and 443 are owned by `banknifty-proxy-1`, the edge proxy of the
`banknifty` compose project in `/home/agent/trade`. The **host** nginx is
installed but inactive; nothing is served from `/etc/nginx/sites-available/`.

Certificate: Let's Encrypt for `delta.thannigo.in`, auto-renewing through the
shared certbot webroot at `/home/agent/trade/proxy/certbot-webroot`. Site
config: `/home/agent/trade/infra/nginx/delta.conf.template`, a copy of
`deploy/nginx.conf`.

## Deploy a change

```bash
./deploy/deploy.sh          # type-checks, builds, starts, health-checks, rolls back on failure
```

Then, if the nginx site config changed:

```bash
install -m 644 deploy/nginx.conf /home/agent/trade/infra/nginx/delta.conf.template
docker exec banknifty-proxy-1 sh -c 'envsubst "$NGINX_ENVSUBST_FILTER" \
    < /etc/nginx/templates/delta.conf.template > /etc/nginx/conf.d/delta.conf'
docker exec banknifty-proxy-1 nginx -t
docker exec banknifty-proxy-1 nginx -s reload
```

`nginx -t` before the reload is not optional.

The template directory is the only durable home for a vhost here. It is
bind-mounted read-only from `./infra/nginx`, so it survives a container
recreate; a file written straight into the container with `docker exec` lives
only in the writable layer and is erased by the next `up -d`. The
`tailscale.thannigo.in` vhost was installed that way and has since been
removed.

## Keeping the data fresh

`deploy/refresh.sh` harvests yesterday and today, snapshots the database and
hands the running container a consistent copy. Installed in cron:

```
40 12 * * * /home/agent/test-delta/deploy/refresh.sh >> /home/agent/test-delta/refresh.log 2>&1
```

12:40 UTC is forty minutes after the daily settlement, so the day is final. Run
it by hand any time; it skips days it already has.

## Two traps this deployment actually hit

**`pkill -f nginx` kills nginx inside containers too.** Container processes are
visible in the host's process table, so a pattern kill reaches them. Doing this
to free ports 80 and 443 stopped `banknifty-proxy-1`, the edge proxy that was
fronting `thannigo.in`, `tailscale.thannigo.in` and `house.api.thannigo.in`, and
took all three offline. To free a port, stop the specific service:
`docker stop <container>` or `systemctl stop nginx` — never a pattern kill.

**The vhost was installed where nothing reads it.** `deploy/nginx.conf` used to
target `/etc/nginx/sites-available/delta.thannigo.in` — the host nginx, which is
inactive. The certificate for `delta.thannigo.in` existed and was valid the whole
time, but no server block referenced it, so requests fell through to whichever
443 block nginx parsed first (`compute.conf`, alphabetically) and were answered
with `tailscale.thannigo.in`'s certificate: `ERR_CERT_COMMON_NAME_INVALID`.

Two guards now exist. The vhost lives in the proxy's template directory, and
`00-default-server.conf.template` declares an explicit `default_server` that
answers unmatched names with `444` on :80 and `ssl_reject_handshake on` on :443.
An unconfigured name now fails at the handshake instead of quietly borrowing a
valid certificate for the wrong domain.

**nginx version matters for `http2`.** The host nginx is 1.18, where the
`http2 on;` directive (added in 1.25) fails to load; the proxy that actually
serves this is 1.27, where `listen ... http2` is deprecated instead. Now that
the file targets the proxy, it uses `http2 on;`.

## Other stacks on this host

The port question is settled: `banknifty-proxy-1` owns 80 and 443, the host
nginx stays inactive, and every public name on this box gets a vhost in
`/home/agent/trade/infra/nginx/`. That is the route `delta.conf.template` now
takes.

The *application* containers of the other stacks — `banknifty-web`,
`banknifty-api`, `house-api`, `house-web` and their databases — are **stopped**.
Only the proxy runs. That is why `thannigo.in` answers 502 and
`house.api.thannigo.in` answers 503: their vhosts resolve and serve the correct
certificates, but there is no upstream behind them. Start those stacks to bring
the names back; it does not affect `delta.thannigo.in`.

## Access

The desk is on the open internet, and the API gates itself. Signing in takes
**two steps, both required**:

1. username and password (scrypt hash, in `auth.db`);
2. the 6-digit code from Google Authenticator (or any TOTP app).

At the first sign-in the second step is set up: a QR code to scan, one code to
verify, and ten recovery codes shown once. A session lasts **24 hours** and is a
row in `auth.db` — so logging out ends it, and changing the password ends every
other one. The gate in `app.ts` decides on the route Fastify matched (never on
the text of the URL) and refuses anything that is not fully signed in. Only
`/api/health` and `/api/me` are public; `/api/login` and the code step carry
their own stage.

`DESK_USER` and `DESK_PASSWORD_HASH` seed the first user; `DESK_SESSION_SECRET`
seals the authenticator secret and must be a real random value. **With any of
them missing the API answers 503 to everything else** — it fails closed, and the
trading engine keeps running behind it. Check `/api/me`.

Repairs, on the server (they are not on the web, on purpose):

```bash
cd app/server && npm run auth -- status          # who, 2FA on?, sessions
npm run auth -- set-password                     # forgotten password
npm run auth -- reset-2fa                        # lost phone
npm run auth -- sign-out-all
# in the container:
docker compose exec api node app/server/dist/auth/cli.js status
```

An nginx-level password is still available as a second door in front of the
static bundle: uncomment the two `auth_basic` lines in `deploy/nginx.conf` and
create the file:

```bash
htpasswd -c /home/agent/trade/proxy/.htpasswd-delta <username>
# mount it into the proxy next to the existing .htpasswd, then:
docker exec banknifty-proxy-1 nginx -t
docker exec banknifty-proxy-1 nginx -s reload
```

## Credentials

None are deployed. Every endpoint the desk reads is public. The account panel
stays disabled unless `DELTA_API_KEY` / `DELTA_API_SECRET` appear in
`app/server/.env`, which is git-ignored and not in any image. `deploy.sh`
refuses to build if `app-ket.txt` is tracked by git or present in its history.
