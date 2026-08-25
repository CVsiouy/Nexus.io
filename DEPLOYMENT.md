# Going Live — step by step

This is the runbook for putting BaseWar.io on the internet. Everything technical
is already built; what remains needs **your** accounts, a domain, and one
decision. Follow it in order.

Every term is explained. If something is unfamiliar, check the glossary in
[MULTIPLAYER_PLAN.md](MULTIPLAYER_PLAN.md) §1.

---

## What you're deploying

Two separate things, in two separate places:

```
   Player's browser
        │
        │  1. downloads the website (HTML/JS)  ──────► Cloudflare Pages (free CDN)
        │
        └─ 2. opens a WebSocket for the game  ───────► your rented server
```

The **frontend** is static files — identical for everyone, cacheable, no game
logic in it at all. That belongs on a CDN: free, fast worldwide, nothing to
manage.

The **backend** holds live match state and must be one specific machine per
match. That needs a rented server.

---

## Step 0 — The decision you still owe

**Where are your first players?** This is the only genuinely blocking question,
because it changes which company you rent from:

| If players are… | Rent from | Why |
|---|---|---|
| India / South Asia | **OVH Mumbai** or **E2E Networks** | ~30ms ping instead of ~150ms |
| Europe / US / global | **Hetzner** (Falkenstein or Ashburn) | Cheapest, and bandwidth is nearly free |
| Genuinely unsure | **Hetzner Falkenstein** | Cheapest place to learn; moving later is a config change, not a rewrite |

**Do not use AWS or Google Cloud.** At 10,000 players you send ~52 TB/month.
Hetzner charges roughly €50 for that; AWS charges about **$5,700**. Same game,
same code. See MULTIPLAYER_PLAN.md §10.2.

### What to buy

- **A domain name** (~$10/year — Namecheap, Cloudflare Registrar, Porkbun)
- **One server.** To start: Hetzner **CPX31** (4 vCPU, 8 GB, ~€14/month). That
  is comfortably enough for the first several hundred players — the load test
  measured ~296 matches per core.

---

## Step 1 — DNS

You need two names pointing at the right places. In your domain registrar's DNS
settings:

| Type | Name | Value | Purpose |
|---|---|---|---|
| `A` | `eu1` | your server's IP address | the game server |
| `CNAME` | `@` or `www` | (given to you by Cloudflare in Step 3) | the website |

**Do this before Step 4.** Certificates are issued by proving you control the
domain, which requires DNS to already point at the server. If it doesn't,
certificate issuance fails and Let's Encrypt rate-limits repeated attempts.

Check it has propagated:

```bash
nslookup eu1.yourdomain.com     # must return your server's IP
```

---

## Step 2 — Prepare the server

SSH into the machine you rented:

```bash
ssh root@YOUR_SERVER_IP
```

Install Docker and nothing else — everything the game needs runs in containers:

```bash
curl -fsSL https://get.docker.com | sh
```

Create a non-root user to run the game. Running internet-facing services as
root means any compromise is a total compromise:

```bash
adduser --disabled-password --gecos "" basewar
usermod -aG docker basewar
```

Basic firewall — only HTTP, HTTPS and SSH reach the machine. The game server
itself is not exposed; only Caddy can reach it, over Docker's private network:

```bash
apt-get update && apt-get install -y ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
```

Get the code:

```bash
su - basewar
git clone YOUR_REPO_URL basewar && cd basewar
```

---

## Step 3 — Frontend on Cloudflare Pages

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, and pick
   this repository.
3. Build settings:

   | Field | Value |
   |---|---|
   | Framework preset | None |
   | Build command | `npm install && npm run build` |
   | Build output directory | `apps/client/dist` |
   | Root directory | *(leave blank)* |

4. Add an **environment variable** — this is how the website knows where your
   game server is:

   | Name | Value |
   |---|---|
   | `VITE_SERVER_URL` | `wss://eu1.yourdomain.com` |

   Note `wss://`, not `ws://`. Browsers refuse unencrypted WebSockets from an
   HTTPS page.

5. Deploy, then **Custom domains** → add `yourdomain.com`. Cloudflare gives you
   the `CNAME` value for Step 1.

Every `git push` now rebuilds and redeploys the frontend automatically, free.

---

## Step 4 — Backend on your server

Back in the SSH session, as the `basewar` user:

```bash
cp infra/.env.example infra/.env
nano infra/.env
```

Fill in the three required values:

```ini
ACME_EMAIL=you@yourdomain.com
SERVER_DOMAIN=eu1.yourdomain.com
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

**`ALLOWED_ORIGINS` matters more than it looks.** It is the list of websites
permitted to connect. Leave it wrong and anyone can host a copy of your client
on their own site, point it at your server, and you pay for their players'
bandwidth with no way to notice. It's verified by
`apps/server/test/origin.mjs`.

Then deploy:

```bash
./infra/deploy.sh
```

The script checks your config, runs the test suite, builds the image, starts
everything, and waits for the server to report healthy. It refuses to continue
if anything is wrong — a deploy that fails halfway is worse than one that never
started.

---

## Step 5 — Check it works

```bash
curl https://eu1.yourdomain.com/health
# {"ok":true,"node":"node1","region":"eu","uptimeSec":42}
```

If HTTPS fails on the first try, wait 30 seconds — the certificate is issued on
the first request. If it still fails, DNS almost certainly isn't pointing here
yet (Step 1).

Then the real test: open `https://yourdomain.com` **on your phone, on mobile
data** — a genuinely different network from the one you built it on. Click
**PLAY ONLINE**. Then do it again in a second browser and confirm you see two
human players.

---

## Step 6 — Monitoring

`/metrics` is deliberately **not** public (Caddy returns 404 for it), because it
exposes internals. Read it over an SSH tunnel:

```bash
ssh -L 9000:localhost:2567 basewar@YOUR_SERVER_IP
# then, locally:
curl localhost:9000/metrics
```

### Hook it up to Grafana (free tier)

1. Sign up at [grafana.com](https://grafana.com) → free Cloud account.
2. **Connections** → **Add** → **Hosted Prometheus metrics** → get the push URL
   and credentials.
3. Add a Grafana Alloy or `prometheus` agent container scraping
   `server:2567/metrics` and remote-writing to Grafana.

### The graphs that actually matter

| Metric | Watch for | Why |
|---|---|---|
| `basewar_tick_duration_ms` p99 | **alert above 25ms** | The single most important number. The budget is 50ms; at 25 you are out of headroom and matches are about to run slow. |
| `basewar_room_errors_total` | **alert on any increase** | Should be exactly zero. Anything else is a bug corrupting live matches. |
| `basewar_players_connected` | growth, and sudden drops | A cliff means people are being disconnected. |
| `basewar_snapshot_bytes_total` | rate per player | Your bandwidth bill, live. Should sit near 6.5 KB/s/player. |
| `basewar_commands_total{result="malformed"}` | sudden spikes | Either a released client has a bug, or somebody is probing you. |
| `basewar_node_nodejs_heap_size_used_bytes` | steady upward drift | A memory leak. |

### Error reporting

Create a free [sentry.io](https://sentry.io) project, then put the DSN in
`infra/.env` as `SENTRY_DSN=...` and redeploy. Leave it blank to skip.

---

## Everyday operations

```bash
# Watch logs (JSON in production — pipe through jq to read them)
docker compose -f docker-compose.prod.yml --env-file infra/.env logs -f server

# Deploy a new version
git pull && ./infra/deploy.sh

# Roll back to a previous image
TAG=v3 ./infra/deploy.sh

# Stop everything
docker compose -f docker-compose.prod.yml --env-file infra/.env down
```

### Deploys don't kick anyone out

Matches are capped at 20 minutes and the server drains gracefully: on a deploy
it stops accepting new players and lets running matches finish. New matches go
to the new version. Nobody is cut off mid-game — that falls out of the match
time limit for free.

---

## When to add a second server

Not yet. One box handles far more than the launch target. Add capacity when:

- `basewar_tick_duration_ms` p99 approaches 25ms, **or**
- `basewar_players_connected` regularly exceeds ~1,500, **or**
- the machine's network is saturating

That's Phase 5 (Redis-backed matchmaking across machines). Until one of those
happens, a second server is money spent on nothing.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| HTTPS fails, certificate errors | DNS not pointing at the server | Fix DNS, wait for propagation, `docker compose ... restart caddy` |
| "This game server does not serve that website" | `ALLOWED_ORIGINS` doesn't exactly match your site | Include the scheme, no trailing slash: `https://yourdomain.com` |
| Website loads, PLAY ONLINE fails | `VITE_SERVER_URL` wrong or still `ws://` | Fix it in Cloudflare Pages env vars and redeploy the frontend |
| "Protocol mismatch: reload the page" | Client and server versions differ | Expected right after a deploy. Frontend and backend must ship together. |
| Server won't start after adding a dependency | Old `node_modules` volume shadowing the new image | `docker compose down -v` then up again |
| Server code changes seem ignored (dev only) | `tsx watch` misses changes through Windows bind-mounts | `docker compose restart server` |

---

## Rough monthly cost at launch

| Item | Cost |
|---|---|
| Frontend — Cloudflare Pages | **$0** |
| Server — Hetzner CPX31 | **€14** |
| Domain | ~$1 |
| Monitoring — Grafana Cloud free tier | **$0** |
| Errors — Sentry free tier | **$0** |
| **Total** | **≈ $17/month** |

At 10,000 concurrent players this grows to roughly $1,000–1,500/month — see
MULTIPLAYER_PLAN.md §12, which now uses measured figures rather than estimates.
