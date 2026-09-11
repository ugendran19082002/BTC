# Security audit — BTC Desk

11 Sep 2026 · repo `test-delta` · live at https://delta.thannigo.in · **fixes not deployed yet**

Scope: the API (Fastify), the web app, sign-in, the Docker and nginx
configuration, dependencies and secrets. **No trading logic was changed.** The
engine, orders, strategy runner, gates and exits are untouched; every change is
in sign-in, request handling, headers and configuration. All server tests
(607) and web tests pass.

Method: code review, local attack probes against the real app
(`app.inject`), the nginx config run in a container, the built web app loaded in
a browser under the new headers, and `npm audit`. The live site itself was
**not** probed.

---

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | 🔴 Critical | Sign-in bypass: `/%61pi/...` reached every API route with no session | **Fixed** |
| 2 | 🔴 High | CORS answered every origin with credentials allowed | **Fixed** |
| 3 | 🔴 High | Sign-in limiter bypassable by forging `X-Forwarded-For` | **Fixed** |
| 4 | 🟠 High | Password only — no second factor on a desk that places live orders | **Fixed** (2FA mandatory) |
| 5 | 🟠 Medium | Sessions could not be ended: logout only cleared the browser cookie | **Fixed** |
| 6 | 🟠 Medium | Page could be framed (clickjacking): security headers never reached HTML | **Fixed** |
| 7 | 🟠 Medium | No CSRF defence beyond SameSite (same-site subdomains get the cookie) | **Fixed** |
| 8 | 🟠 Medium | Missing auth config left the whole desk open (fail-open) | **Fixed** (fail-closed) |
| 9 | 🟡 Low | No password change without editing `.env` and redeploying | **Fixed** |
| 10 | 🟡 Low | `hash-password.mjs` imported a file that had moved (command failed) | **Fixed** |
| 11 | 🟡 Low | Sign-in refusals could flood the error log | **Fixed** |
| 12 | 🟡 Low | Web port 8099 published on all host interfaces | TODO (infra) |
| 13 | 🟡 Low | `/api/health` shows migration ids and counts without sign-in | TODO |
| 14 | 🟡 Low | Delta API key, desk password, Telegram token were pasted in chat | TODO (rotate) |
| 15 | 🟡 Low | `DESK_SESSION_SECRET` strength unknown | TODO |
| — | ✅ | Dependencies: `npm audit` finds 0 vulnerabilities (server and web) | — |
| — | ✅ | SQL: every query uses prepared statements; no string-built SQL | — |
| — | ✅ | No `dangerouslySetInnerHTML`, `eval` or `new Function` anywhere | — |
| — | ✅ | API container: non-root user, read-only root FS, all capabilities dropped, no-new-privileges | — |
| — | ✅ | Source maps not shipped; secrets not in images; `.env` git-ignored | — |

---

## 1. 🔴 Critical — sign-in bypass through an encoded path

**What:** the session gate tested the text of the URL (`req.url.startsWith('/api/')`).
The router decodes percent-escapes before matching. So `/%61pi/strategies`
(`%61` = `a`) failed the text test, skipped the gate, and was routed to
`/api/strategies` anyway.

**Proof (local):**

```
GET /api/strategies     401 {"error":"not signed in"}
GET /%61pi/strategies   200 {"today":"2026-09-11","schedulerOn":false,...}
GET /%61pi/errors       200 {"errors":[],...}
```

Every route was affected, including `POST /api/trade/place` and
`POST /api/trade/close-all`. The web nginx (`location /api/` +
`proxy_pass http://api:8787;`) normalises the path to pick the location but
passes the **original** encoded URI upstream, so the live site is very likely
open the same way.

**Fix:** the gate now decides on the route Fastify actually matched
(`req.routeOptions.url` and the route's own `config.auth`), never on the URL
text. It fails closed: every route needs a full session unless ittext. Public routes are named by the route itself (`config.auth`), so a new
route is protected unless it says otherwise. A request matching no route gets
Fastify's 404, which carries no data.

**Pinned by:** `test/http/auth-gate.test.ts` — seven spellings of a protected
path (`/%61pi/...`, `/%61%70%69/...`, `/api/%73trategies`, a trailing slash, a
query that looks like a public path) must all answer 401 or 404 and leak nothing.

---

## 2. 🔴 High — CORS answered every origin, with credentials

**What:** `origin: (_origin, cb) => cb(null, true)` with `credentials: true`.
Any page anywhere could call the API with the desk's cookie and read the reply
wherever the browser let the cookie through — including any other site on
`thannigo.in`, which `SameSite=Strict` treats as the same site.

**Proof (local):** `GET /api/me` with `Origin: https://evil.example` came back
with `access-control-allow-origin: https://evil.example` and
`access-control-allow-credentials: true`.

**Fix:** CORS removed. The page and the API share one origin behind the proxy,
so a cross-origin browser call has no legitimate caller.

---

## 3. 🔴 High — the sign-in limiter could be walked past

**What:** `trustProxy: true` trusts every hop, so Fastify took the left-most —
client-written — address in `X-Forwarded-For` as `req.ip`. A new value per
request meant a new counter per request, and the 8-per-10-minutes limit counted
nothing.

**Fix:** two changes.
- `trustProxy` now lists only the private ranges the proxies sit on, so the
  address counted is the right-most one no trusted proxy vouched for.
- Sign-in is limited **per account as well as per address**: 20 wrong passwords
  in 15 minutes locks sign-in wherever it comes from, and 10 wrong codes does
  the same. An address cannot be faked into a different account.

**Trade-off, on purpose:** an attacker who knows the username can lock sign-in
for 15 minutes. For a one-person desk, being locked out for 15 minutes beats
letting a password be guessed forever. The CLI (`npm run auth`) always works on
the server itself.

---

## 4. 🟠 High — password only, on a desk that places live orders

**Fixed:** two-step sign-in is now required, and cannot be switched off from the
web at all.

- **Sign-in:** password → 6-digit code from Google Authenticator (any TOTP app)
  → desk. The password alone only opens a 5-minute step that accepts a code.
- **First sign-in:** password → security setup (QR code, or the key typed by
  hand) → verify a code → **ten recovery codes**, shown once → desk. The desk
  does not open until the codes are acknowledged.
- **Codes:** RFC 6238, SHA-1, 30 seconds, 6 digits, one step either side
  accepted; pinned to the RFC's own test vectors. A code already used is
  refused, so one seen over a shoulder is worthless.
- **Recovery codes:** ten, `XXXX-XXXX`, each usable once, stored only as an
  HMAC. Using one raises a Telegram alert saying how many are left.
- **Lost phone:** `npm run auth -- reset-2fa` on the server, then set it up
  again at the next sign-in.
- **The secret** is sealed with AES-256-GCM under a key derived from
  `DESK_SESSION_SECRET`, so a copy of `auth.db` alone opens nothing.

---

## 5. 🟠 Medium — sessions could not be ended

**What:** the session was a signed `expiry.signature` cookie with nothing behind
it. Logging out only cleared the browser's copy: the same cookie kept working
until it expired. Changing the password (then: editing `.env`) ended nothing.

**Fix:** sessions are rows in `auth.db`, and only the SHA-256 of each token is
stored. Logging out ends the session on the server. Changing the password ends
**every other** session. The account page lists the devices signed in — what
they are, their address, when they were last active — with one button to sign
the others out. Sessions last **24 hours** from sign-in; the cookie is
`__Host-desk_session`, `HttpOnly`, `Secure`, `SameSite=Strict`.

---

## 6. 🟠 Medium — the page could be framed

**What:** nginx only inherits `add_header` into a location with **no**
`add_header` of its own. Every location in `nginx.docker.conf` sets
`Cache-Control`, so the server-level `X-Frame-Options`, `X-Content-Type-Options`
and `Referrer-Policy` reached only `/api/`. The HTML page itself went out with
none of them and could be put in an invisible iframe over another page — where a
tap lands on a real button of this desk.

**Fix:** the headers are repeated in every location, and a
`Content-Security-Policy` and `Permissions-Policy` added. Checked by serving the
built app through this exact config: the headers are on `/`, `/index.html`,
`/assets/` and `/api/`, and the app loads with no CSP violation.

---

## 7. 🟠 Medium — no CSRF defence beyond SameSite

**What:** `SameSite=Strict` keeps other *sites* out, but everything under
`thannigo.in` counts as the same site and gets the cookie.

**Fix:** every POST, PUT, PATCH and DELETE must carry an `Origin` (or a
`Referer`) naming this host. A request with neither — not a browser page — still
needs the session cookie. `DESK_ALLOWED_ORIGINS` can name extra origins if one
is ever needed.

---

## 8. 🟠 Medium — a missing configuration left the desk open

**What:** with `DESK_USER`, `DESK_PASSWORD_HASH` or `DESK_SESSION_SECRET`
missing, sign-in was skipped entirely and every route answered.

**Fix:** fail closed. With no user, or no secret to seal with, everything but
`/api/health` and `/api/me` answers 503. The trading engine keeps running, so an
open position is still managed and still exits — the screen is what closes, not
the desk.

---

## 9–11. 🟡 Low — fixed

- **Change the password from the screen.** Profile → Change password: current
  password, the new one twice against the rules as they are typed (12+
  characters, not the username, not the old one), and a fresh authenticator
  code. The password now lives in `auth.db`; `.env` only ever seeds the first
  one. Telegram is told when it changes.
- **`hash-password.mjs`** imported `./src/session.ts`, which had moved to
  `src/http/`; the command in the TODO failed. Fixed, and mostly replaced by
  `npm run auth`.
- **Sign-in refusals** (401, 429, 403) are marked deliberate, so guessing cannot
  fill the error log.

---

## Still to do

| # | What | Why it is not done here |
|---|---|---|
| 12 | Publish the web port on the loopback or the docker gateway only (`127.0.0.1:8099:80` or a firewall rule), so nothing reaches the app except through the TLS edge | Changes how the live site is reached; needs care and your OK |
| 13 | `/api/health` shows migration ids and counts to anyone | Deploy checks read it; worth narrowing to `{ok, days}` and moving the rest behind sign-in |
| 14 | Rotate the Delta API key, the desk password and the Telegram token | Only you can do these, on Delta and in BotFather |
| 15 | Make `DESK_SESSION_SECRET` 32 random bytes (`openssl rand -base64 32`) if it is short | Rotating it re-seals nothing: 2FA must be set up again after, so do it with the next deploy |
| 16 | HSTS has no `includeSubDomains`/`preload` | Only safe once every `thannigo.in` subdomain is HTTPS |

---

## What was checked and found sound

- **SQL:** every statement is prepared with bound parameters; no query is built
  by string concatenation.
- **Injection into the page:** no `dangerouslySetInnerHTML`, no `eval`, no
  `new Function`. React escapes the error log and every server string.
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities for the
  server and for the web app.
- **Containers:** the API runs as a non-root user with a read-only root
  filesystem, all Linux capabilities dropped, `no-new-privileges`, and no host
  port. The API port is only reachable over the compose network.
- **Secrets:** `.env` is git-ignored, is not in any image, and is read once at
  start. The Telegram token is scrubbed from anything the notifier reports. The
  session cookie carries no secret; the TOTP secret is sealed; recovery codes
  and the password are only ever stored as hashes.
- **Trading:** unchanged. No file under `src/trading/` or `src/strategy/` was
  touched by this audit, and all 607 server tests pass.
