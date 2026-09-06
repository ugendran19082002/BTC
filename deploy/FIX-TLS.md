# delta.thannigo.in — TLS

Two separate problems, in order. Solve them in order.

---

## Problem 1: certbot cannot bind port 80 (`Error 98`)

```
nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Unknown error)
nginx: [emerg] still could not bind()
```

Error 98 is `EADDRINUSE`. Something already holds port 80, so the nginx that
certbot's `--nginx` plugin manages cannot start.

The evidence says that something is not the host nginx:

```
$ curl -I https://tailscale.thannigo.in     # resolved to 204.168.233.179
HTTP/2 502
server: nginx/1.27.5
cache-control: no-store, must-revalidate
```

A 502 means the nginx answering on 443 is a *proxy* whose upstream is down —
it is a routing layer, very likely running in Docker (Nginx Proxy Manager and
similar images produce exactly this response). Meanwhile the host has its own
nginx package installed, which is the one certbot found and tried to restart.

### Identify it for certain

```bash
sudo ss -ltnp | grep -E ':(80|443)\s'
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
systemctl is-active nginx
```

Read the `ss` output: the process name in the last column is the owner. If it
is `docker-proxy` or `nginx` inside a container, you are in case A.

### Case A — a container owns 80/443 (expected)

**Do not run `certbot --nginx` on the host at all.** It manages a different
nginx from the one serving traffic; even if it could bind, its config would not
be the config in use.

If the container is Nginx Proxy Manager, do it in its admin UI:

1. Proxy Hosts → Add Proxy Host
   - Domain: `delta.thannigo.in`
   - Forward to: the desk's web container, `127.0.0.1` port `8099`
   - Websockets: off. Block common exploits: on.
2. SSL tab → Request a new SSL Certificate → Force SSL → HTTP/2 → Save.

NPM runs ACME itself, holds port 80, and needs no certbot.

If it is a plain nginx container instead, add `deploy/nginx.conf` to whatever
host directory is mounted into it, then issue the certificate with webroot
rather than the nginx plugin:

```bash
sudo certbot certonly --webroot -w /var/www/html -d delta.thannigo.in
```

`-w` must point at the host directory that the container serves
`/.well-known/acme-challenge/` from. If it does not serve that path yet, add
the `location /.well-known/acme-challenge/` block from `deploy/nginx.conf`
first and reload the container.

### Case B — a stray host nginx

If `ss` shows a plain host `nginx` and `systemctl is-active nginx` says
`active`, then certbot is fighting a copy of itself — usually a manually
started nginx alongside the systemd one:

```bash
sudo systemctl stop nginx
sudo pkill -f nginx          # kills anything systemd did not start
sudo ss -ltnp | grep ':80\s' # must print nothing
sudo systemctl start nginx
sudo certbot --nginx -d delta.thannigo.in
```

### Fallback that needs no port 80 at all

Works in every case; you prove ownership through DNS instead:

```bash
sudo certbot certonly --manual --preferred-challenges dns -d delta.thannigo.in
```

certbot prints a `_acme-challenge.delta.thannigo.in` TXT record. Add it at your
DNS provider, wait for it to propagate, press enter. The certificate lands in
`/etc/letsencrypt/live/delta.thannigo.in/`. Point whichever proxy actually
serves 443 at those files.

Renewal is manual with this method, so prefer A or B if you can.

---

## Problem 2: the desk is not on that host

Fixing the certificate stops the browser warning. It does not put anything
behind the name — that 502 will just become your 502.

```bash
# from your machine, in this repo
./deploy/deploy.sh --host root@204.168.233.179
```

That builds both images locally, ships them over SSH and starts the stack with
the web container published on `127.0.0.1:8099`, which is what the proxy config
above forwards to.

Verify before pointing DNS traffic at it:

```bash
ssh root@204.168.233.179 'curl -s localhost:8099/api/health'
```

---

## Problem 3: decide who can reach it

The desk shows your sizing and, if you enable the account panel, your
positions. Right now anyone who resolves the name would be able to open it.

- Quickest: uncomment the `auth_basic` lines in `deploy/nginx.conf` and create
  the password file with `htpasswd -c /etc/nginx/.htpasswd-delta <username>`.
- Better, and this box already runs Tailscale: publish the web container on the
  Tailscale address instead of `0.0.0.0` and never expose it publicly. In
  `deploy/docker-compose.yml`, change the web port mapping to
  `"100.x.y.z:8099:80"` using the host's Tailscale IP.

Do not click through the browser warning as a workaround. On a page that shows
account data, that warning is telling you the truth.
