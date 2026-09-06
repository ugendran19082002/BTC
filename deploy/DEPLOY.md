# Deploying to delta.thannigo.in (204.168.233.179)

Nothing here has been run against your server. These are the files and the
exact commands; run them yourself, or give me SSH access and say the word and
I will run them.

## Before anything else

1. **Revoke the Delta API key that is in `app-ket.txt`.** It was pasted into
   chat more than once. Issue a fresh one only if you actually want the account
   panel, and give it read-only permissions.
2. Decide whether this host should be public at all. Right now it answers
   HTTP 301. If this desk is only for you, put it behind basic auth or a
   VPN — it shows your positions and your sizing.

## One-time server setup

```bash
adduser --system --group --home /srv/btc-desk btcdesk
apt-get install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

## Deploy

```bash
# on your machine
rsync -av --exclude node_modules --exclude .env --exclude app-ket.txt \
      ./ root@204.168.233.179:/srv/btc-desk/

# on the server
cd /srv/btc-desk/app/server && npm ci && npm run build
cd /srv/btc-desk/app/web    && npm ci && npm run build
chown -R btcdesk:btcdesk /srv/btc-desk

install -m 644 /srv/btc-desk/deploy/btc-desk-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now btc-desk-api

install -m 644 /srv/btc-desk/deploy/nginx.conf \
        /etc/nginx/sites-available/delta.thannigo.in
ln -sf /etc/nginx/sites-available/delta.thannigo.in /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

certbot --nginx -d delta.thannigo.in
```

## Credentials, if you enable the account panel

```bash
install -o btcdesk -g btcdesk -m 600 /dev/null /srv/btc-desk/app/server/.env
# then edit it and put the NEW key in; never commit this file
systemctl restart btc-desk-api
```

Without that file the desk still works. Every chain, candle, ticker and
backtest endpoint reads public market data.

## Keeping the chain cache fresh

The backtest reads `chain/*.json`. Refresh daily, after the 12:00 UTC
settlement:

```
30 12 * * *  btcdesk  cd /srv/btc-desk && /usr/bin/python3 harvest_chain.py \
             $(date -u +\%Y-\%m-\%d) $(date -u +\%Y-\%m-\%d) >> /var/log/btc-desk-harvest.log 2>&1
```

Then `curl -X POST localhost:8787/api/reload` so the running process picks the
new day up.

## What is deliberately not here

No order placement, no withdrawal, no key in any config that ships. If you want
the desk to trade, that is a separate decision and a separate review — and not
one to take while the AlgoTest reconciliation in `TODO.md` is still open.
