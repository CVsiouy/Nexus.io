#!/usr/bin/env bash
#
# One-command deploy.
#
#   ./infra/deploy.sh
#
# Checks the configuration, builds the image, runs the tests, and starts the
# stack — refusing to proceed if anything is wrong, because a deploy that fails
# halfway is worse than one that never started.
#
# Safe to re-run: it replaces the running server with the new build. In-progress
# matches drain rather than being cut off (see stop_grace_period).

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="infra/.env"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file $ENV_FILE"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

# ── 1. Configuration ────────────────────────────────────────────────────────
say "Checking configuration"

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Copy infra/.env.example to it and fill it in."

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

for var in ACME_EMAIL SERVER_DOMAIN ALLOWED_ORIGINS; do
  [ -n "${!var:-}" ] || die "$var is not set in $ENV_FILE. See DEPLOYMENT.md."
done
ok "required variables present"

case "$ALLOWED_ORIGINS" in
  *localhost*|*127.0.0.1*)
    printf '  \033[33m!\033[0m ALLOWED_ORIGINS contains localhost — fine for staging, wrong for production\n' ;;
  https://*) ok "ALLOWED_ORIGINS looks like a real site" ;;
  *) die "ALLOWED_ORIGINS should start with https:// (got: $ALLOWED_ORIGINS)" ;;
esac

# ── 2. Tests ────────────────────────────────────────────────────────────────
# Deploying code that fails its own tests is never the right call. Set
# SKIP_TESTS=1 only when you already know why.
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  say "Running tests"
  docker run --rm -v "$PWD":/app -w /app node:20-alpine npm test \
    || die "Tests failed. Fix them, or set SKIP_TESTS=1 if you know what you are doing."
  ok "tests pass"
else
  printf '  \033[33m!\033[0m skipping tests (SKIP_TESTS=1)\n'
fi

# ── 3. Build ────────────────────────────────────────────────────────────────
say "Building the server image"
$COMPOSE build server
ok "image built"

# ── 4. Frontend ─────────────────────────────────────────────────────────────
# Only needed when self-hosting the frontend. With Cloudflare Pages this is a
# no-op and the CDN builds it for you on push.
if [ -n "${FRONTEND_DOMAIN:-}" ] && [ "${FRONTEND_DOMAIN}" != "localhost" ]; then
  say "Building the frontend bundle for $FRONTEND_DOMAIN"
  docker run --rm \
    -v "$PWD":/app -w /app \
    -e "VITE_SERVER_URL=wss://${SERVER_DOMAIN}" \
    node:20-alpine sh -c "npm install --no-audit --no-fund >/dev/null && npm run build"
  ok "bundle written to apps/client/dist"
fi

# ── 5. Start ────────────────────────────────────────────────────────────────
say "Starting the stack"
$COMPOSE up -d --remove-orphans
ok "containers up"

# ── 6. Verify ───────────────────────────────────────────────────────────────
say "Waiting for the server to report healthy"
for i in $(seq 1 30); do
  if $COMPOSE exec -T server node -e \
      "fetch('http://127.0.0.1:2567/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok "server is healthy"
    break
  fi
  [ "$i" -eq 30 ] && die "Server did not become healthy. Check: $COMPOSE logs server"
  sleep 2
done

say "Deployed"
cat <<EOF
  Game server   wss://${SERVER_DOMAIN}
  Frontend      ${FRONTEND_DOMAIN:-(on a CDN)}

  Logs          $COMPOSE logs -f server
  Metrics       $COMPOSE exec server wget -qO- localhost:2567/metrics
  Stop          $COMPOSE down

  TLS certificates are issued on the first request to your domain and may take
  a few seconds. If HTTPS fails at first, check DNS points here and retry.
EOF
