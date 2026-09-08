# Deployment — delta.thannigo.in

**Live**: https://delta.thannigo.in

This is the state as actually deployed, not a plan.

## What runs where

`204.168.233.179` **is this machine**. `delta.thannigo.in` resolves to it, and
the repo lives on it at `/home/agent/test-delta`. `deploy.sh --host` therefore
loops back over SSH to localhost, which works but is pointless — use the plain
form.

```
browser ──443──> host nginx 1.18 ──> 127.0.0.1:8099 ──> btc-desk-web  (nginx:1.27-alpine, static build)
                                                              └──────> btc-desk-api  (Fastify, no host port)
                                                                              └────> /srv/data/chain.db  (volume)
```

Certificate: Let's Encrypt for `delta.thannigo.in`, auto-renewing, installed by
certbot. Site config: `/etc/nginx/sites-available/delta.thannigo.in`, a copy of
`deploy/nginx.conf`.

## Deploy a change

```bash
./deploy/deploy.sh          # type-checks, builds, starts, health-checks, rolls back on failure
```

Then, if the nginx site config changed:

```bash
sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/delta.thannigo.in
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` before the reload is not optional.

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

**The host nginx is 1.18, not 1.27.** The `http2 on;` directive arrived in 1.25;
on 1.18 it is an unknown directive and the whole config fails to load. This file
set uses `listen 443 ssl http2;`, which both versions accept.

## Other stacks on this host

`banknifty` (in `/home/agent/trade`), `house` and `house-dev` are **stopped**,
at your request. Restarting `banknifty` will fail or conflict while the host
nginx holds 80 and 443 — that proxy publishes those ports. If you bring it back,
pick one owner for those ports: either stop the host nginx and add a
`delta.conf.template` vhost to `/home/agent/trade/infra/nginx/` (follow
`house.conf.template`, and attach `btc-desk-web` to the `edge` network), or
leave the host nginx in charge and give the other sites vhosts there instead.

## Access

The desk is on the open internet. It shows position sizing, and would show open
positions if the account panel were ever enabled. To require a password,
uncomment the two `auth_basic` lines in `deploy/nginx.conf` and create the file:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-delta <username>
sudo nginx -t && sudo systemctl reload nginx
```

## Credentials

None are deployed. Every endpoint the desk reads is public. The account panel
stays disabled unless `DELTA_API_KEY` / `DELTA_API_SECRET` appear in
`app/server/.env`, which is git-ignored and not in any image. `deploy.sh`
refuses to build if `app-ket.txt` is tracked by git or present in its history.
