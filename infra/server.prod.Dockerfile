# Production image for the game server (the backend).
#
# Differences from the dev image:
#   • the source is COPIED IN, not bind-mounted — the image is self-contained
#   • dev-only dependencies are omitted
#   • it runs as a non-root user, so a compromise inside the container is not
#     automatically root inside it
#   • it has a HEALTHCHECK, so Docker restarts it if it wedges
#
# A note on running TypeScript directly: we ship `tsx` rather than compiling to
# JavaScript first. It costs ~100ms of startup on a process that runs for weeks,
# and it removes a build step that could fail at deploy time — which is the
# worst possible moment for something to fail.

FROM node:20-alpine

# dumb-init makes the process the correct PID 1, so SIGTERM actually reaches
# Node. Without it, `docker stop` kills the container instead of letting the
# graceful shutdown finish the matches that are still running.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Manifests first, so `npm ci` is cached and only re-runs when a dependency changes.
COPY package.json package-lock.json* ./
COPY packages/sim/package.json      packages/sim/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json       apps/server/package.json

# `npm ci` installs exactly what the lockfile says — reproducible, unlike
# `npm install` which may quietly resolve to newer versions.
# --omit=dev leaves out test tooling and the client's build deps.
RUN npm ci --omit=dev --workspace @basewar/server --include-workspace-root \
 || npm install --omit=dev

# Only what the server actually needs.
COPY packages/sim      packages/sim
COPY packages/protocol packages/protocol
COPY apps/server/src   apps/server/src

# Drop root. `node` is a non-root user that already exists in this base image.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/server
ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
