# delta.thannigo.in — ERR_CERT_COMMON_NAME_INVALID

## What is actually wrong

```
$ openssl s_client -connect 204.168.233.179:443 -servername delta.thannigo.in
subject = CN = tailscale.thannigo.in
X509v3 Subject Alternative Name: DNS:tailscale.thannigo.in
```

The host serves nginx 1.27.5. Port 80 has a server block for
`delta.thannigo.in` that redirects to HTTPS, but **port 443 has no server block
for that name**. nginx therefore answers with its default HTTPS server, whose
certificate covers `tailscale.thannigo.in` only. The browser sees a certificate
that does not match the name it asked for and refuses.

So: the redirect on port 80 was set up, the HTTPS side never was.

Nothing of this project is deployed on that host yet. Fixing the certificate
will stop the browser warning; it will not put the desk there. Both steps below
are needed.

## Step 1 — issue a certificate for the name

```bash
# on the server, as root
certbot --nginx -d delta.thannigo.in
```

certbot needs port 80 to answer the challenge. It already does — that is the
block issuing the 301 — but the redirect must not swallow the challenge path.
If certbot fails with a 404 on `/.well-known/acme-challenge/...`, install the
config below first (it puts the challenge location above the redirect), reload
nginx, and run certbot again.

Check it worked:

```bash
openssl s_client -connect 127.0.0.1:443 -servername delta.thannigo.in </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
# expect: CN = delta.thannigo.in
```

## Step 2 — put the desk behind it

```bash
# from your machine, in this repo
./deploy/deploy.sh --host root@204.168.233.179
```

That builds both images locally, ships them over SSH, and starts the stack with
the web container on `127.0.0.1:8099`.

Then install the reverse proxy config:

```bash
# on the server
install -m 644 ~/btc-desk/deploy/nginx.conf \
        /etc/nginx/sites-available/delta.thannigo.in
ln -sf /etc/nginx/sites-available/delta.thannigo.in /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

`nginx -t` before the reload is not optional — a bad config plus a reload takes
the other sites on this box down with it.

## Step 3 — decide who can reach it

The desk shows your account sizing and, if you ever enable the account panel,
your positions. Right now anyone who resolves the name can open it. Either:

- uncomment the `auth_basic` lines in `deploy/nginx.conf` and create the
  password file, or
- bind the stack to your Tailscale interface instead of `127.0.0.1` and never
  expose it publicly at all — this box already runs Tailscale.

The second is better if the desk is only for you.

## What not to do

Do not click through the browser warning as a permanent workaround. The warning
is accurate: the connection is not authenticated for that name, and on a page
that will show account data that matters.
