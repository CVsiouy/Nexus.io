# Commands

> ## ⚠️ Read this first: which terminal are you in?
>
> VS Code opens **PowerShell** by default on Windows, and **PowerShell cannot run
> `.sh` files**. Typing `./basewar.sh dev` there makes Windows try to *open* the
> file — your editor pops up and nothing runs. It looks like the command was
> ignored.
>
> **In PowerShell** (the VS Code default) use the `.ps1` wrapper:
> ```powershell
> .\basewar.ps1 dev
> .\basewar.ps1 playtest
> ```
>
> **In Git Bash** use the shell script:
> ```bash
> ./basewar.sh dev
> ./basewar.sh playtest
> ```
>
> Both do exactly the same thing — `basewar.ps1` just hands the command to Git
> Bash for you. To switch VS Code's terminal: the **`∨`** dropdown next to the
> `+` in the terminal panel → **Git Bash**.
>
> The raw `docker` commands below work in **either** terminal.

Every command for this project. **Node.js is not installed on your machine** —
everything runs inside Docker, so wherever a tutorial says `npm run something`,
you use the Docker version here instead.

Each entry shows three things:

- **Normally** — what you'd type if Node were installed (for understanding; don't run these)
- **You type** — the Docker command that actually works
- **Shortcut** — the `./basewar.sh` wrapper, which handles the Windows quirks for you

Run everything from the project root:
`c:\Users\ChiragVerma\OneDrive - Gentell\Desktop\Game\NexusMultiplayer.io`

---

## Two Windows quirks, explained once

You'll see these in every raw Docker command. They exist because Git Bash and
Docker Desktop disagree about what a path looks like.

**`MSYS_NO_PATHCONV=1`** — Git Bash helpfully rewrites anything that looks like a
Unix path before handing it to a Windows program. So `-w /app` (a path *inside*
the container) gets mangled into `C:/Users/.../app`, and Docker fails with
*"the working directory is invalid"*. This turns that rewriting off.

**`$(pwd -W)`** — plain `pwd` gives `/c/Users/...`, which Docker Desktop doesn't
accept for volume mounts. `pwd -W` gives `C:/Users/...`, which it does.

`./basewar.sh` detects Windows and applies both automatically, which is the main
reason to use it.

---

## Everyday

### Start the game

**Normally:** `npm run dev`

**You type:**
```bash
docker compose up -d --build
```
**Shortcut:** `./basewar.sh dev`

Then open **http://localhost:5173**. The backend is at http://localhost:2567.

### Stop

```bash
docker compose down
```
**Shortcut:** `./basewar.sh stop`

### Watch what the server is doing

```bash
docker compose logs -f server
docker compose logs -f client
```
**Shortcut:** `./basewar.sh logs` · `./basewar.sh logs client`

Ctrl-C stops watching; it does not stop the server.

### Restart the server after editing `apps/server/`

```bash
docker compose restart server
```
**Shortcut:** `./basewar.sh restart`

**Why this is needed:** the file watcher misses changes made through Windows
bind-mounts. If a server edit seems to have no effect, this is why. Frontend
changes (`apps/client/`) hot-reload fine and need nothing.

### What's running?

```bash
docker compose ps
```
**Shortcut:** `./basewar.sh status`

---

## Testing

### Everything

**Shortcut:** `./basewar.sh test` — runs all three suites below in order.

### Simulation + client (server not needed)

**Normally:** `npm test`

**You type:**
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/app -w /app node:20-alpine npm test
```
**Shortcut:** `./basewar.sh test:unit`

This spins up a throwaway container (`--rm` deletes it afterwards), mounts your
code at `/app`, and runs the tests. Nothing is installed on your machine.

### Protocol + binary codec (20 tests, TypeScript)

```bash
docker compose exec server npx tsx --test test/protocol.test.ts test/snapshot.test.ts
```
**Shortcut:** `./basewar.sh test:protocol`

These run *inside the already-running server container*, which is why they need
`./basewar.sh dev` first — that container has the TypeScript runner.

### Live: two real clients in one match (26 checks)

```bash
docker compose exec server npx tsx test/integration.mjs
```
**Shortcut:** `./basewar.sh test:live`

### Play one match to the end

```bash
docker compose exec server node test/oneMatch.mjs
```

Useful with a short match limit to check telemetry is being written.

---

## Performance

### How many matches fit on one CPU core

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/app -w /app \
  -e ROOMS=20 -e WARMUP_SEC=900 node:20-alpine node apps/loadtest/src/rooms.mjs
```
**Shortcut:** `./basewar.sh loadtest` (or `./basewar.sh loadtest 50`)

`WARMUP_SEC=900` fast-forwards 15 minutes of game time first, so it measures a
busy late-game match rather than a nearly empty one. Last measured: **296
matches per core**.

### Bandwidth per player — this is your hosting bill

```bash
docker compose exec -e WARMUP_SEC=150 server npx tsx test/bandwidth.mjs
```
**Shortcut:** `./basewar.sh bandwidth`

Takes ~2.5 minutes. Last measured: **6.5 KB/s per player**.

---

## Playing with friends

### Get a public link to share

```bash
./infra/playtest.sh
```
**Shortcut:** `./basewar.sh playtest`

Prints a link. Send it on WhatsApp — friends anywhere can open it in a browser.
Ctrl-C stops everything and the link dies. See [PLAYTEST.md](PLAYTEST.md).

### See what actually happened afterwards

```bash
docker compose -f docker-compose.playtest.yml run --rm server node ../loadtest/src/analyse.mjs
```
**Shortcut:** `./basewar.sh analyse`

Reads `data/matches.jsonl` and reports the snowball check, match lengths,
spectating time, and player feedback.

---

## Monitoring

```bash
curl http://localhost:2567/health     # is it alive?
curl http://localhost:2567/ready      # should it take new players?
curl http://localhost:2567/metrics    # all the numbers
```
**Shortcut:** `./basewar.sh health` · `./basewar.sh metrics`

Just the game's own numbers:
```bash
curl -s http://localhost:2567/metrics | grep "^basewar_"
```

The one that matters most is `basewar_tick_duration_ms` — alert if its 99th
percentile approaches 25ms (the budget is 50ms).

---

## Changing dependencies

### Add a package

**Normally:** `npm install some-package --workspace @basewar/server`

**You type:**
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/app -w /app node:20-alpine \
  npm install some-package --workspace @basewar/server
```

**Then you must rebuild:**
```bash
docker compose down -v
docker compose up -d --build
```

**The `-v` is not optional.** It removes the anonymous `node_modules` volumes.
Without it, the old volume shadows your freshly built image and the new package
is invisible — you get `Cannot find package 'x'` even though it's clearly in
`package.json`. This cost me a debugging round; don't repeat it.

**Shortcut for the rebuild:** `./basewar.sh reset`

---

## Production

### Deploy

```bash
./infra/deploy.sh
```
**Shortcut:** `./basewar.sh deploy`

Needs `infra/.env` — copy `infra/.env.example` and fill it in. Full walkthrough
in [DEPLOYMENT.md](DEPLOYMENT.md).

### Production logs

```bash
docker compose -f docker-compose.prod.yml --env-file infra/.env logs -f server
```
**Shortcut:** `./basewar.sh prod:logs`

### Build the production image without deploying

```bash
MSYS_NO_PATHCONV=1 docker build -f infra/server.prod.Dockerfile -t basewar-server:test .
```

---

## When things break

| Symptom | Command | Why |
|---|---|---|
| `Cannot find package 'x'` after adding a dependency | `./basewar.sh reset` | Old `node_modules` volume shadowing the new image |
| Server edits seem ignored | `./basewar.sh restart` | Watcher misses Windows bind-mount changes |
| `invalid file request` when building | already handled | Caused by OneDrive; our Dockerfiles avoid `COPY . .` |
| `the working directory is invalid` | add `MSYS_NO_PATHCONV=1` | Git Bash mangled the container path |
| Weird build errors, `parent snapshot does not exist` | `./basewar.sh clean` | Docker's build cache is corrupt |
| `error during connect: ... dockerDesktopLinuxEngine` | Start Docker Desktop | The engine isn't running |
| Nothing works, no idea why | `./basewar.sh clean` then `./basewar.sh dev` | Full rebuild from scratch |

### Check Docker itself is alive

```bash
docker version
```

---

## Git

Git **is** installed, so these are normal commands:

```bash
git status
git add -A
git commit -m "your message"
git push
git log --oneline -10
```

---

## Quick reference

| I want to… | Command |
|---|---|
| Play locally | `./basewar.sh dev` → http://localhost:5173 |
| Play with friends | `./basewar.sh playtest` |
| Stop everything | `./basewar.sh stop` |
| Run all tests | `./basewar.sh test` |
| See the logs | `./basewar.sh logs` |
| Restart after a server edit | `./basewar.sh restart` |
| Check bandwidth cost | `./basewar.sh bandwidth` |
| Check server capacity | `./basewar.sh loadtest` |
| Review a playtest | `./basewar.sh analyse` |
| Fix a broken build | `./basewar.sh reset` |
| Deploy for real | `./basewar.sh deploy` |
| See all of these | `./basewar.sh help` |
