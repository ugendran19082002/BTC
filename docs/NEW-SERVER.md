# Standing the desk up on a new server

How to take a fresh Ubuntu machine from nothing to a running BTC desk, from
`git clone` to the first sign-in. Every command is meant to be pasted in
order. Where this host differs from the one at `delta.thannigo.in`, that is
noted; [DEPLOY.md](DEPLOY.md) describes *that* host as it is.

## 0. Decide what this server is for — before anything else

**Never run two live desks on one Delta account.** Each desk is its own
trading engine: it reads the positions, places the morning entry, chases,
adds, protects and exits. Two of them on the same key will both sell the
morning strategy, both place stops, and each will treat the other's orders as
something to reconcile away. So the copy is one of these, and you say which
when you write its `.env`:

| The copy is… | `DELTA_LIVE_TRADING` | API key | Databases |
|---|---|---|---|
| **A paper copy** — to try things, or a warm standby | `0` | a new **read-only** key, or none | fresh |
| **The new home** — the old server is being retired | `1` | a new key with trade rights; **the old desk stopped first** | copied from the old server |
| **A second account** | `1` | that account's key | fresh |

Only one machine may hold a key with trade rights at a time.

## 1. The machine

- Ubuntu 22.04 or 24.04, 2 cores / 4 GB is enough (the current host is 4 / 8
  and idles at 100 MB). 20 GB disk: Docker images come to ~7 GB with the
  releases the deploy script keeps.
- A public IP, or Tailscale if it should not be on the internet at all.
- Ports 22, 80 and 443 open. **Nothing else.**

```bash
sudo apt update && sudo apt install -y git curl python3 ufw
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

### Docker (with compose v2)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker          # or log out and in
docker compose version # must print v2.x
```

### Node 24 (the deploy script runs the tests and the type-check on the host)

`node:sqlite` needs Node 22.5 or newer; the images build on 24, so match it.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v24.x
```

Python is only for the harvester and uses nothing outside the standard
library.

## 2. Get the code

The repository is private: `git@github.com:ugendran19082002/BTC.git`. Give the
new server its own read-only deploy key rather than copying your personal
key onto it:

```bash
ssh-keygen -t ed25519 -C "btc-desk deploy $(hostname)" -f ~/.ssh/btc-desk -N ""
cat ~/.ssh/btc-desk.pub
# GitHub → the BTC repo → Settings → Deploy keys → Add → paste, leave "write" unticked
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/btc-desk
  IdentitiesOnly yes
EOF
git clone git@github.com:ugendran19082002/BTC.git ~/test-delta
cd ~/test-delta
```

The path can be anything; `~/test-delta` keeps the cron line below identical
to the old server's.

## 3. Configure

Everything the desk needs at runtime is one file, `app/server/.env`. It is
git-ignored, never enters an image, and the deploy script refuses to build if
a credential file is tracked.

```bash
cp app/server/.env.example app/server/.env
chmod 600 app/server/.env
```

Then fill it in. The file itself explains every line; these are the ones that
matter:

| Variable | Set it to | How |
|---|---|---|
| `DESK_USER` | your sign-in name | — |
| `DESK_PASSWORD_HASH` | scrypt hash of a **new** password | `cd app/server && npm ci && npx tsx hash-password.mjs` |
| `DESK_SESSION_SECRET` | 32 random bytes | `openssl rand -base64 32` |
| `DELTA_LIVE_TRADING` | `0` for a paper copy, `1` only for the new home | see §0 |
| `DELTA_API_KEY` / `DELTA_API_SECRET` | a **new** key made on Delta for this server | see below |
| `TG_TOKEN` / `TG_CHAT_ID` | optional; the same bot and chat work from any server | — |

**The Delta key.** Delta India keys are bound to an IP allow-list; a call
from an address not on the list answers `ip_not_whitelisted_for_api_key` and
the desk shows the account as unavailable. So on Delta: create a new key,
give it *read* rights (add *trade* only for the new home), and whitelist the
new server's public IP (`curl -4 ifconfig.me`). Do not reuse a key that has
ever been pasted into a chat, a screenshot or a file — the first items in
[TODO.md](TODO.md) are about exactly that.

The password hash and session secret here seed the first user into the
database and are then ignored; afterwards the password lives in the `auth`
schema and is changed from the profile screen.

**The database password** goes in a second file, `deploy/.env` (copy
`deploy/.env.example`): `POSTGRES_PASSWORD=` followed by `openssl rand -base64 24`.
Compose creates the database with it on the first `up`, and refuses to start
without it. It never leaves the compose network; there is no host port.

## 4. The data

Two things hold the desk's data:

| Where | What it is | For a paper copy | For the new home |
|---|---|---|---|
| `chain.db`, in the Docker volume `btc-desk_data` | 735 days of option chains, the 733-day record every figure is tested against | **copy it** | copy it |
| the PostgreSQL database `btc_desk`, volume `btc-desk_pgdata` | the order journal, strategies, settings, MTM samples, sign-in, error log, market cache, analytics tables | fresh | copy it (`btc_desk.dump`) |

### Two commands

On the **old** server — the desk keeps running, the copies are consistent
(SQLite's backup API for `chain.db`, `pg_dump` for the database):

```bash
cd ~/test-delta
./deploy/export-data.sh            # chain.db + btc_desk.dump  -> data-export/btc-desk-data-<stamp>.tar.gz
./deploy/export-data.sh --chain    # chain.db only: all a paper copy needs
scp data-export/btc-desk-data-*.tar.gz newserver:/tmp/
```

On the **new** server, after the first `./deploy/deploy.sh` in §5 has created
the volume:

```bash
cd ~/test-delta
./deploy/import-data.sh /tmp/btc-desk-data-<stamp>.tar.gz
```

It stops the API, puts `chain.db` in the volume and at the repository root for
`refresh.sh`, restores `btc_desk.dump` over this server's database with
`pg_restore` (in one transaction), starts the API and waits for `/api/health`.

Two things the scripts will not do for you:

- **Neither `.env` is in the tarball** — they hold the exchange key, the
  session secret and the database password. Carry them by hand, and read §3
  before reusing any key. The new server's `POSTGRES_PASSWORD` may differ from
  the old one's: the dump carries data, not roles.
- **The sign-in tables open only under the same `DESK_SESSION_SECRET`** they
  were sealed with. Same secret in the new `.env`: the password, the authenticator and the
  recovery codes all carry over. New secret: `cd app/server && npm run auth --
  reset-2fa`, then scan a new QR at the next sign-in.

For a move, stop the old desk's *trading* before exporting its journal
(`docker compose -f deploy/docker-compose.yml stop api` on the old server) —
otherwise it goes on placing orders against positions the new server now
thinks are its own.

## 5. Deploy

```bash
cd ~/test-delta
./deploy/deploy.sh --check      # installs deps, runs both suites and type-checks; changes nothing
./deploy/deploy.sh              # builds the images, starts, health-checks, rolls back on failure
```

If a reverse proxy on **this** host will front the desk (§6), publish the web
port on loopback only — a port Docker publishes on `0.0.0.0` is open to the
internet whatever ufw says:

```bash
WEB_BIND=127.0.0.1 ./deploy/deploy.sh
```

(`WEB_BIND` is remembered nowhere; pass it on every deploy, or export it in
`~/.bashrc`.) Then the chain data:

```bash
./deploy/refresh.sh             # harvests yesterday+today into chain.db and hands it to the container
curl -s http://127.0.0.1:8099/api/health   # "days":735 or so, "schema" through 008-mtm-samples
```

And the daily refresh, after the 17:30 IST settlement:

```bash
(crontab -l 2>/dev/null; echo 'CRON_TZ=UTC'; \
 echo '40 12 * * * /home/'"$USER"'/test-delta/deploy/refresh.sh >> /home/'"$USER"'/test-delta/refresh.log 2>&1') | crontab -
```

## 6. HTTPS in front of it

The desk must not be reached over plain HTTP: the session cookie is marked
`Secure` and the browser will not send it. The simplest thing that works on a
fresh host is Caddy, which gets and renews the certificate itself:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
desk.example.com {
    reverse_proxy 127.0.0.1:8099
    header {
        X-Frame-Options DENY
        X-Content-Type-Options nosniff
        Referrer-Policy same-origin
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }
}
EOF
sudo systemctl reload caddy
```

Point the DNS A record at the server first; Caddy needs port 80 reachable to
prove the name. If you would rather use nginx, `deploy/nginx.conf` is the
vhost the current host runs, and the notes at its top say what to change.

**Not on the internet at all?** Install Tailscale, skip the proxy, and deploy
with `WEB_BIND=<tailscale ip>`; the desk is then only reachable inside the
tailnet, over HTTP — in which case the `Secure` cookie needs an HTTPS
listener anyway: `tailscale serve --bg 8099` gives you one with a certificate.

## 7. First sign-in

Open the site. Sign in with `DESK_USER` and the password you hashed; the
desk shows a QR code — scan it in Google Authenticator, enter one code, and
**save the ten recovery codes**. A session then lasts a week.

Check, in this order:

1. The header shows **PAPER** (or LIVE only if you meant it — §0).
2. Account card: *Available* has a number, not "unavailable". If not, the
   key's IP allow-list is the first suspect: `docker logs btc-desk-api-1 --since 5m | grep -i whitelist`.
3. Price chart draws, the chain fills, the P&L tab opens.
4. Telegram, if set: the startup line in `docker logs btc-desk-api-1` says
   `telegram fill alerts on`; the first message arrives with the first fill.

## 8. Day to day

```bash
cd ~/test-delta && git pull && ./deploy/deploy.sh   # update
docker logs btc-desk-api-1 --since 1h               # what the engine did
docker compose -f deploy/docker-compose.yml ps      # what is running
cd app/server && npm run auth -- status             # who is signed in
```

Deploys keep the previous release and roll back to it if the new one fails
its health check. The volume outlives every container; `docker compose down
-v` is the one command that would delete the journal — do not run it.

## Checklist

- [ ] §0 decided: paper copy / new home / second account, and the old desk stopped if it is a move
- [ ] Docker, compose v2, Node 24, Python 3, ufw with 22/80/443
- [ ] Deploy key added on GitHub, repo cloned
- [ ] `app/server/.env` filled, `chmod 600`, new Delta key with this server's IP whitelisted
- [ ] `chain.db` copied to the repo root
- [ ] `./deploy/deploy.sh --check` green, then `./deploy/deploy.sh` (with `WEB_BIND=127.0.0.1` behind a local proxy)
- [ ] `./deploy/refresh.sh` run once; cron line installed
- [ ] HTTPS in front; `/api/health` answers through the public name
- [ ] Signed in, 2FA set up, recovery codes saved
- [ ] Header says PAPER unless this is the one live desk
