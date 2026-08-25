#!/usr/bin/env bash
#
# basewar — one command for everything.
#
#   ./basewar.sh help
#
# Every task in this project runs inside Docker, and several of the commands are
# long and easy to get subtly wrong. This wraps all of them, and handles the
# Windows/Git-Bash path quirks automatically so you never have to remember
# MSYS_NO_PATHCONV or `pwd -W`.

set -euo pipefail
cd "$(dirname "$0")"

# ── Windows compatibility ───────────────────────────────────────────────────
# Git Bash rewrites anything that looks like a Unix path when passing it to a
# Windows program, which mangles container paths (/app becomes C:/…/app).
# MSYS_NO_PATHCONV disables that, and `pwd -W` gives the Windows-style path
# Docker Desktop needs for volume mounts.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) export MSYS_NO_PATHCONV=1; HOSTPWD="$(pwd -W)" ;;
  *)                    HOSTPWD="$(pwd)" ;;
esac

DC="docker compose"
DC_PLAY="docker compose -f docker-compose.playtest.yml"
DC_PROD="docker compose -f docker-compose.prod.yml --env-file infra/.env"
NODE_IMG="node:20-alpine"

# Runs a command in a throwaway container with the repo mounted. Used for things
# that don't need the server running.
in_node() { docker run --rm -v "$HOSTPWD":/app -w /app "$@"; }

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

server_up() { $DC ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -q '^server running$'; }
need_server() {
  server_up || die "The server isn't running. Start it first:  ./basewar.sh dev"
}

usage() {
  # PowerShell users invoke this through basewar.ps1, which sets BASEWAR_CMD.
  # Printing "./basewar.sh" to them would be a command that silently does nothing
  # in their shell — which is exactly the confusion this wrapper exists to fix.
  local me="${BASEWAR_CMD:-./basewar.sh}"
  cat <<EOF

  basewar — project commands

  EVERYDAY
    $me dev              Start the game locally  → http://localhost:5173
    $me stop             Stop everything
    $me restart          Restart the server (needed after editing apps/server)
    $me logs [service]   Follow logs (default: server)
    $me status           What's running

  TESTING
    $me test             Everything: units + protocol + live match
    $me test:unit        Simulation + client (56 tests, no server needed)
    $me test:protocol    Command validator + binary codec (20 tests)
    $me test:live        Two real clients in one match (27 checks)

  PERFORMANCE
    $me loadtest [rooms] How many matches fit on one CPU core
    $me bandwidth        KB/s per player — this is your hosting bill

  PLAYTEST WITH FRIENDS
    $me playtest         Public link to share. Friends anywhere can join.
    $me analyse          What actually happened — snowball check, feedback

  PRODUCTION
    $me deploy           Deploy to your server (needs infra/.env)
    $me prod:logs        Production logs
    $me health           Is the local server alive?
    $me metrics          Raw monitoring numbers

  WHEN THINGS BREAK
    $me reset            Rebuild from scratch (fixes "module not found"
                         after adding a dependency)
    $me clean            Also clears Docker's build cache

EOF
}

cmd="${1:-help}"; shift || true

case "$cmd" in

  # ── Everyday ─────────────────────────────────────────────────────────────
  dev|up|start)
    say "Starting the game"
    $DC up -d --build
    ok "running"
    printf '\n  Play      http://localhost:5173\n'
    printf '  Backend   http://localhost:2567/health\n'
    printf '  Logs      ./basewar.sh logs\n\n'
    ;;

  stop|down)
    say "Stopping"; $DC down --remove-orphans; ok "stopped" ;;

  restart)
    # tsx's file watcher misses edits made through Windows bind-mounts, so a
    # manual restart is the reliable way to pick up server changes.
    say "Restarting the server"; $DC restart server; ok "restarted (give it ~10s)" ;;

  logs)   $DC logs -f "${1:-server}" ;;
  status) $DC ps ;;

  # ── Testing ──────────────────────────────────────────────────────────────
  test)
    say "Simulation + client"
    in_node "$NODE_IMG" npm test
    say "Protocol + binary codec"
    need_server
    $DC exec -T server npx tsx --test test/protocol.test.ts test/snapshot.test.ts
    say "Live: two clients, one match"
    $DC exec -T server npx tsx test/integration.mjs
    ;;

  test:unit)     in_node "$NODE_IMG" npm test ;;
  test:protocol) need_server; $DC exec -T server npx tsx --test test/protocol.test.ts test/snapshot.test.ts ;;
  test:live)     need_server; $DC exec -T server npx tsx test/integration.mjs ;;

  # ── Performance ──────────────────────────────────────────────────────────
  loadtest)
    rooms="${1:-20}"
    say "Measuring capacity with $rooms matches (warming up to a late-game state)"
    in_node -e "ROOMS=$rooms" -e WARMUP_SEC=900 "$NODE_IMG" node apps/loadtest/src/rooms.mjs
    ;;

  bandwidth)
    need_server
    say "Measuring bytes per player (takes ~2.5 minutes)"
    $DC exec -T -e WARMUP_SEC=150 server npx tsx test/bandwidth.mjs
    ;;

  # ── Playtest ─────────────────────────────────────────────────────────────
  playtest)
    # Invoked via `bash` rather than directly: Windows checkouts often lose the
    # executable bit, and "Permission denied" here would be baffling.
    exec bash ./infra/playtest.sh ;;

  analyse|analyze)
    [ -f data/matches.jsonl ] || die "No match data yet. Run ./basewar.sh playtest and finish a match."
    $DC_PLAY run --rm -T server node ../loadtest/src/analyse.mjs
    ;;

  # ── Production ───────────────────────────────────────────────────────────
  deploy)     exec bash ./infra/deploy.sh ;;
  prod:logs)  $DC_PROD logs -f "${1:-server}" ;;

  health)
    curl -s http://localhost:2567/health && echo || die "No response. Is it running? ./basewar.sh dev" ;;

  metrics)
    curl -s http://localhost:2567/metrics | grep -E '^basewar_(rooms|players|bots|commands|joins|room_errors|snapshot|matches)' \
      || die "No response. Is it running? ./basewar.sh dev" ;;

  # ── Recovery ─────────────────────────────────────────────────────────────
  reset)
    # `down -v` removes the anonymous node_modules volumes. Without this, a
    # newly added dependency stays invisible because the old volume shadows the
    # freshly built image — the "Cannot find package" trap.
    say "Rebuilding from scratch"
    $DC down -v --remove-orphans || true
    $DC build --no-cache
    $DC up -d
    ok "rebuilt"
    ;;

  clean)
    say "Clearing Docker build cache too (slower next build, fixes weird errors)"
    $DC down -v --remove-orphans || true
    docker builder prune -af
    ok "cleaned — run ./basewar.sh dev next"
    ;;

  help|--help|-h) usage ;;
  *) printf '\n  Unknown command: %s\n' "$cmd"; usage; exit 1 ;;
esac
