# Adminer — the database console

`https://adminer.thannigo.in` — a web console on the desk's PostgreSQL
database. For looking, mostly: what is in the journal, why a strategy did not
run, what the error log folded. Changing a row here bypasses every check the
desk's own routes make (the short cap's ceiling, a strategy's validation, the
append-only journal), so the account for everyday use cannot write.

## What stands in front of it

Outermost first. Each one alone would be too little for a database console on
a public name.

| Layer | Where | What it does |
|---|---|---|
| TLS, HSTS, `noindex`, `frame-ancestors 'none'` | edge vhost `deploy/nginx-adminer.conf` | |
| Basic auth | edge, `.htpasswd-btc-adminer` (bcrypt) | Nobody reaches Adminer's own page without it. Its own file, not banknifty's. |
| POST rate limit, 10/min per address | edge | Adminer checks the **database password before its own one-time code**, so without this the login form is an unlimited password oracle for anyone past basic auth. |
| Optional IP allow-list | edge (commented `allow` / `deny`) | Recommended if your addresses are stable. |
| Bridge-only port | compose: `172.17.0.1:8098` | Reachable by the edge proxy as `host.docker.internal`; not from the host's public address. |
| One-time code (`login-otp`) | `deploy/adminer/plugins-enabled/002-login-otp.php` | A code from an authenticator app at every sign-in. **Fails closed**: with no `ADMINER_OTP_SECRET`, sign-in is refused. |
| Pinned server (`login-servers`) | `001-login-servers.php` | The Server field is a one-item list: `db`. Adminer cannot be pointed at another host (the class of bug behind CVE-2021-21311). |
| No permanent login | `003-no-permanent-login.php` | Sessions end with the browser; the flag is stripped server-side. |
| `desk_ro` | `deploy/db-readonly-role.sh` | SELECT only, every desk schema, 30 s statement limit, read-only transactions, 5 connections, and **no access** to `auth.user`, `auth.sessions`, `auth.recovery_codes`. |
| Container | compose `adminer` | Opt-in profile, pinned `adminer:6.0.1-standalone`, read-only root, all capabilities dropped, 0.5 CPU / 256 MB. |

The owner account (`desk`, `POSTGRES_PASSWORD`) also works through the console,
and can write. Use it deliberately, and only for something the desk's own
screens cannot do.

The look: **pepa-linha** in light mode, **dracula** when your system is dark —
`deploy/adminer/theme/`, copied from the image's own `designs/` so Adminer
recognises them. To try another, copy `designs/<name>/adminer.css` (or
`adminer-dark.css`) out of the image over the file there and restart.

## Setting it up (once)

After the database cutover (`DEPLOY.md`), on the server:

```bash
# 1. secrets, into deploy/.env (see deploy/.env.example)
openssl rand -base64 24            # -> DB_READONLY_PASSWORD=
./deploy/adminer-otp.sh            # -> ADMINER_OTP_SECRET=, and the otpauth:// link for your phone

# 2. the read-only account
./deploy/db-readonly-role.sh

# 3. the edge password (bcrypt), in the proxy's template directory
htpasswd -B -c /home/agent/trade/infra/nginx/.htpasswd-btc-adminer <username>
chmod 644 /home/agent/trade/infra/nginx/.htpasswd-btc-adminer

# 4. the certificate (webroot, same as delta; renewed by the existing timer)
sudo certbot certonly --webroot -w /home/agent/trade/proxy/certbot-webroot -d adminer.thannigo.in

# 5. the vhost -- `nginx -t` before the reload is not optional
install -m 644 deploy/nginx-adminer.conf /home/agent/trade/infra/nginx/btc-adminer.conf.template
docker exec banknifty-proxy-1 sh -c 'envsubst "$NGINX_ENVSUBST_FILTER" \
    < /etc/nginx/templates/btc-adminer.conf.template > /etc/nginx/conf.d/btc-adminer.conf'
docker exec banknifty-proxy-1 nginx -t && docker exec banknifty-proxy-1 nginx -s reload
```

Step 4 must come before step 5: the vhost names a certificate that has to
exist, and a failed `nginx -t` on the shared proxy is the one mistake here that
could touch the other sites. The htpasswd file sits in the template directory
because that directory is already mounted into the proxy; no container needs
recreating. It is a hash, but keep that directory out of any repository.

## Using it

```bash
docker compose -f deploy/docker-compose.yml --profile admin up -d adminer   # open
docker compose -f deploy/docker-compose.yml stop adminer                     # close, when done
```

Sign in with basic auth, then: Server `BTC desk (btc_desk)`, username `desk_ro`,
its password, the 6-digit code, database `btc_desk`.

Stopped is its normal state. While it is stopped the name answers 502 behind
the password.

## Changing things

- **New read-only password**: change it in `deploy/.env`, run
  `./deploy/db-readonly-role.sh`.
- **Lost phone**: `./deploy/adminer-otp.sh`, new secret into `deploy/.env`,
  `up -d adminer` again.
- **Upgrading Adminer**: change the pinned tag, re-copy the two theme files from
  the new image's `designs/`, and check the plugin constructors still match
  (`plugins/login-servers.php`, `plugins/login-otp.php`).
