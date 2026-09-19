# syntax=docker/dockerfile:1.7

# ---------- build the API ----------
FROM node:24.12-alpine AS server-build
WORKDIR /build/server
# copy manifests first so a source-only change reuses the install layer
COPY app/server/package.json app/server/package-lock.json ./
# A cache mount, so a lockfile change re-resolves but does not re-download every
# tarball. The layer cache already covers "nothing changed"; this covers the far
# commoner "one dependency moved".
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
COPY app/server/tsconfig.json ./
COPY app/server/src ./src
RUN npm run build

# ---------- production dependencies only ----------
FROM node:24.12-alpine AS server-deps
WORKDIR /build/server
COPY app/server/package.json app/server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev

# The front end is built by Dockerfile.web, which is what the web image uses.
# A `web-build` stage lived here too and nothing ever copied out of it -- BuildKit
# skips an unreferenced stage, so it cost nothing at build time and cost every
# reader of this file a minute working out where its output went.

# ---------- runtime ----------
FROM node:24.12-alpine AS runtime
# tini reaps zombies and forwards signals, so the container stops promptly
RUN apk add --no-cache tini
ENV NODE_ENV=production PORT=8787 CHAIN_DB=/srv/data/chain.db
WORKDIR /srv

COPY --from=server-deps /build/server/node_modules ./app/server/node_modules
COPY --from=server-build /build/server/dist ./app/server/dist
COPY app/server/package.json ./app/server/package.json

# chain.db is the only file this process touches outside the image, and it
# opens it read-only; everything it writes goes to PostgreSQL (DATABASE_URL).
# SQLite in WAL mode still needs the directory writable for its shared-memory
# file, so it is a volume, not image content.
RUN mkdir -p /srv/data && chown -R node:node /srv/data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app/server/dist/index.js"]
