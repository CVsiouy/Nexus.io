# Dev image for the game server (the backend).
#
# Like the client image, this contains only the dependency tree — the source
# arrives via a bind-mount at run time, so editing a .ts file restarts the
# server in about a second instead of rebuilding an image.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY packages/sim/package.json      packages/sim/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/client/package.json       apps/client/package.json
COPY apps/server/package.json       apps/server/package.json

RUN npm install

# 2567 is the Colyseus convention. The client connects here over WebSocket.
EXPOSE 2567

WORKDIR /app/apps/server
CMD ["npm", "run", "dev"]
