# Production image for the frontend.
#
# TWO WAYS TO SHIP THE FRONTEND, and you should prefer the first:
#
#   1. Cloudflare Pages (recommended). The frontend is just static files, so a
#      CDN serves them from a city near each player, for free, with nothing to
#      manage. See DEPLOYMENT.md.
#
#   2. This image. Serves the same files from your own server via Caddy. Useful
#      if you want everything on one box, or for a staging environment.
#
# Multi-stage: the first stage has Node and the whole toolchain to build the
# bundle; the second contains only Caddy and the finished files. The result is a
# ~50MB image instead of ~400MB, and nothing that can execute JavaScript.

# ── Stage 1: build the bundle ────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/sim/package.json      packages/sim/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/client/package.json       apps/client/package.json

RUN npm ci || npm install

COPY packages/sim        packages/sim
COPY packages/protocol   packages/protocol
COPY apps/client         apps/client

# Where the browser should look for the backend. Baked in at BUILD time because
# Vite substitutes it into the bundle — so a rebuild is needed to change it.
ARG VITE_SERVER_URL=wss://localhost:2567
ENV VITE_SERVER_URL=$VITE_SERVER_URL

RUN npm run build --workspace @nexus/client

# ── Stage 2: serve it ───────────────────────────────────────────────────────
FROM caddy:2-alpine

COPY --from=build /app/apps/client/dist /srv
COPY infra/Caddyfile.static /etc/caddy/Caddyfile

EXPOSE 80 443
