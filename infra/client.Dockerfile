# Dev image for the browser client (Vite dev server).
#
# This image deliberately contains NO application source — only the dependency
# tree. docker-compose bind-mounts packages/ and apps/client/ over the top at
# run time, so your edits appear instantly and the image never has to be rebuilt
# for a code change. Only touching a package.json requires a rebuild.
#
# (Phase 4 adds a separate production Dockerfile that DOES copy and build the
# source into a static bundle for deployment.)
FROM node:20-alpine

WORKDIR /app

# Workspace manifests only. npm needs every package.json present to link the
# workspace together, and copying just these means `npm install` is cached and
# re-runs only when a dependency actually changes.
COPY package.json ./
COPY packages/sim/package.json      packages/sim/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/client/package.json       apps/client/package.json

RUN npm install

EXPOSE 5173

WORKDIR /app/apps/client
CMD ["npm", "run", "dev"]
