# Wallet: one image serves the API and the built Angular UI on a single port.
#
#   build       npm ci for all workspaces, then `npm run build` (Angular UI + tsup bundle of the API)
#   prod-deps   only what the API needs at run time. better-sqlite3 13 ships prebuilt binaries for
#               linux x64 and arm64 (glibc) inside its npm package, and no dependency compiles anything,
#               so there is no python3/make/g++ anywhere and nothing to download besides npm packages
#   runtime     node:24-slim plus the files below, running as the unprivileged `node` user
#
# Layout of the runtime image. It is what the code resolves, so change it only together with
# backend/src/lib/paths.ts and backend/src/config.ts:
#
#   /app/backend/package.json                BACKEND_ROOT = nearest package.json above dist/index.js
#   /app/backend/dist/index.js               tsup bundle (inlines @wallet/shared)
#   /app/backend/drizzle/                    MIGRATIONS_DIR = BACKEND_ROOT/drizzle (applied on startup)
#   /app/frontend/dist/frontend/browser/     default static dir = BACKEND_ROOT/../frontend/dist/frontend/browser
#   /app/node_modules/                       external runtime dependencies: better-sqlite3, drizzle-orm, express, helmet, zod
#   /data/                                   volume: SQLite database (+ WAL files) and backups
#
# Build and run:  docker compose up -d --build   (see docker-compose.yml)

# ---- build ---------------------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
ENV NG_CLI_ANALYTICS=false

# Manifests first: the dependency layer is rebuilt only when a package.json or the lockfile changes.
# npm ci checks the lockfile against every workspace, so all three manifests are needed.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# The e2e workspace (Playwright tests, see e2e/README.md) is left out on purpose: .dockerignore excludes
# it, and `npm ci` treats a workspace whose folder is missing as absent (checked with a dry run: the
# lockfile still validates and nothing from e2e is installed), so no browser tooling enters the image.
# --ignore-scripts: the only packages with install scripts (esbuild, @parcel/watcher, lmdb, msgpackr-extract)
# are dev-only and get their binaries from optional platform packages, so nothing needs a script
# (npm 12 blocks them by default anyway) and nothing gets compiled.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

COPY shared shared
COPY backend backend
COPY frontend frontend
RUN npm run build

# ---- prod-deps -----------------------------------------------------------------------------------
FROM node:24-slim AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# Only the backend workspace, without devDependencies: no Angular, no build tools. (npm still adds about
# 15 MB of rxjs, tslib and @types/*, which come from the frontend workspace and from drizzle-orm's
# optional peers; they are harmless.) @wallet/shared is removed: the bundle already contains it, so
# the workspace symlink would only dangle.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace=@wallet/backend --ignore-scripts --no-audit --no-fund \
    && rm -rf node_modules/@wallet

# ---- runtime -------------------------------------------------------------------------------------
FROM node:24-slim AS runtime

# TZ decides what "today" is (backend/src/lib/today.ts uses the server's local zone) and so when a
# month ends: set it in docker-compose.yml / .env. Node reads zone rules from its bundled ICU data,
# so the image needs no tzdata package.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3400 \
    DATABASE_PATH=/data/wallet.db \
    BACKUP_DIR=/data/backups \
    TZ=UTC

WORKDIR /app
# Root-owned and read-only for the app user: the code cannot be modified at run time.
# /app/backend comes from prod-deps: package.json (marks BACKEND_ROOT) plus any nested node_modules.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/backend ./backend
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/drizzle ./backend/drizzle
COPY --from=build /app/frontend/dist/frontend/browser ./frontend/dist/frontend/browser

# The data volume. It is created and chowned here, before VOLUME, so that a fresh named volume
# inherits the ownership of the `node` user (uid 1000). A bind mount keeps the host's ownership.
RUN mkdir -p /data/backups && chown -R node:node /data
VOLUME ["/data"]

# The official image defines `node` as uid/gid 1000, so the name is stable.
# hadolint ignore=DL3066
USER node
EXPOSE 3400

# node:24-slim has no curl or wget, so the probe is node itself: exit 0 on a 2xx answer from
# /api/health (which also runs `select 1` on the database), 1 on any other status, error or timeout.
# The port comes from the PORT variable. docker-compose.yml repeats this check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3400) + '/api/health', { signal: AbortSignal.timeout(4000) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]

# node, not `npm start`: npm would sit between Docker and the app and swallow SIGTERM.
CMD ["node", "backend/dist/index.js"]
