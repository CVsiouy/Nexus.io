#!/usr/bin/env bash
#
# Get 8 real people playing your game, right now, on your own machine.
#
#   ./infra/playtest.sh
#
# Opens two temporary public HTTPS addresses (Cloudflare Tunnel) pointing at your
# local containers, then prints a link to share. No server to rent, no domain, no
# DNS. Stop with Ctrl-C and the addresses vanish.
#
# Why a tunnel rather than "just send them my IP": browsers refuse plain `ws://`
# connections from an HTTPS page, so the game needs a real certificate. A tunnel
# provides one instantly; setting that up yourself is Phase 4's whole runbook.

set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.playtest.yml"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

cleanup() {
  printf '\n\033[1;36m▸ Shutting down the playtest\033[0m\n'
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
  printf '  Telemetry kept in ./data — analyse it with:\n'
  printf '    docker compose -f docker-compose.playtest.yml run --rm server node ../loadtest/src/analyse.mjs\n\n'
}
trap cleanup EXIT INT TERM

mkdir -p data

# Reads the public address cloudflared prints to its own logs.
wait_for_tunnel() {
  local service="$1" label="$2" url=""
  for _ in $(seq 1 40); do
    url=$($COMPOSE logs "$service" 2>&1 \
          | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
          | tail -1 || true)
    [ -n "$url" ] && { echo "$url"; return 0; }
    sleep 2
  done
  die "The $label tunnel never came up. Check: $COMPOSE logs $service"
}

# ── 1. Backend + its public address ─────────────────────────────────────────
say "Starting the game server"
$COMPOSE up -d --build server tunnel-server
ok "server running"

say "Opening a public address for it"
SERVER_URL=$(wait_for_tunnel tunnel-server "game server")
# https:// → wss://, because the browser opens a WebSocket to it.
WSS_URL="${SERVER_URL/https:/wss:}"
ok "$WSS_URL"

# ── 2. Frontend, pointed at that address ────────────────────────────────────
say "Starting the website"
VITE_SERVER_URL="$WSS_URL" $COMPOSE up -d --build client tunnel-client
ok "website running"

say "Opening a public address for it"
CLIENT_URL=$(wait_for_tunnel tunnel-client "website")
ok "$CLIENT_URL"

# ── 3. Check it actually works before telling anyone ────────────────────────
say "Verifying"
for _ in $(seq 1 20); do
  if curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; then ok "server is healthy"; break; fi
  sleep 2
done
curl -fsS -o /dev/null "$CLIENT_URL" 2>/dev/null && ok "website is reachable" \
  || printf '  \033[33m!\033[0m website not answering yet — give it a few seconds\n'

# ── 4. Share this ───────────────────────────────────────────────────────────
cat <<EOF

╔════════════════════════════════════════════════════════════════════╗
   SEND THIS LINK TO YOUR PLAYERS

     $CLIENT_URL

   They enter a name and click PLAY ONLINE. Empty seats are filled by
   bots, so it works with any number of people — you do not need all 8.
╚════════════════════════════════════════════════════════════════════╝

  Watch it live:
    $COMPOSE logs -f server

  After the session, see what actually happened:
    $COMPOSE run --rm server node ../loadtest/src/analyse.mjs

  What to look for is in PLAYTEST.md.

  Ctrl-C to stop. The addresses die with it.

EOF

# Stay alive so the tunnels stay up; the trap cleans up on Ctrl-C.
$COMPOSE logs -f server
