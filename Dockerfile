# tBoard web server image (multi-stage).
#
# The server bundle (out/server/index.js) keeps better-sqlite3 + fastify
# external, so the runtime image needs production node_modules. better-sqlite3
# v13 ships N-API prebuilds for linux-x64/arm64 IN the npm package, so a plain
# `npm ci` (even with --ignore-scripts) yields a working native binary without
# a compiler or an Electron download. Debian base (glibc) matches the prebuild.

# --- build stage: install deps + build renderer/server bundles --------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips the root's electron-builder postinstall (dev-only) and
# is safe: better-sqlite3's prebuilt binary already ships in its package.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# --- runtime stage: only production deps + built output ---------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only the prod deps the external-bundled server needs (fastify, better-sqlite3…).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/out ./out

# Run unprivileged; the DB lives on a mounted volume.
RUN useradd --system --user-group --home-dir /app tboard \
    && mkdir -p /data && chown -R tboard:tboard /data /app
USER tboard

ENV TBOARD_DB_PATH=/data/tboard.sqlite
ENV TBOARD_SERVER_HOST=0.0.0.0
ENV TBOARD_SERVER_PORT=8787
EXPOSE 8787

# ENTRYPOINT (not CMD) so extra args append: `docker run <image>` starts the
# server, and `docker run <image> hash "passphrase"` runs the hash subcommand.
ENTRYPOINT ["node", "out/server/index.js"]
