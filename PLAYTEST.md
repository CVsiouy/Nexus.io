# Playtesting with real people

Everything built so far is verified *correct*. None of it tells you whether the
game is *fun*. Only eight humans in a room can do that, and this is how to get
them there in about five minutes.

---

## Run it

```bash
./infra/playtest.sh
```

That's it. The script starts your local game, opens two temporary public HTTPS
addresses, checks they work, and prints a link to share:

```
╔════════════════════════════════════════════════════════════════════╗
   SEND THIS LINK TO YOUR PLAYERS

     https://some-random-words.trycloudflare.com
╚════════════════════════════════════════════════════════════════════╝
```

Players enter a name and click **PLAY ONLINE**. Ctrl-C stops everything and the
addresses vanish.

### Why not just deploy to Vercel?

You can put the **website** on Vercel — it's excellent at static sites. But
Vercel **cannot run the game server**, and it's worth understanding why before
you spend an evening on it:

Vercel is *serverless*: it starts a function to answer a request, then throws it
away. Your game server is the opposite — one long-lived process holding match
state in memory, ticking 20 times a second, with WebSockets open for 20 minutes.

| Your game needs | Serverless gives |
|---|---|
| A process alive for 20+ minutes | Functions capped at 10–300 seconds |
| Match state held in memory between ticks | Memory discarded after each request |
| Long-lived WebSocket connections | Not supported for persistent socket servers |

A tunnel sidesteps all of it: your own machine runs the server (easily — we
measured ~296 matches per core), and Cloudflare provides the public HTTPS
address. When you're ready for something permanent, that's
[DEPLOYMENT.md](DEPLOYMENT.md).

---

## Make the session useful

### Shorten the matches

Twenty minutes is right for a real game and wrong for a test. You learn far more
from six 8-minute matches than two 20-minute ones, and nobody wants their very
first game to last twenty minutes.

Add to `docker-compose.playtest.yml` under the `server` service:

```yaml
      - MATCH_LIMIT_MS=480000     # 8 minutes
```

### You don't need all 8 people

Empty seats are filled by bots, so 3 friends works fine. But **more humans is
much more informative** — the whole risk we're testing is how humans behave
towards each other, which bots don't reproduce. Aim for at least 4.

### Tell them almost nothing

Resist explaining how to play. Watching someone be confused is the single most
valuable thing in a playtest, and you only get one chance per person. Say:

> "Enter a name, click Play Online. Tell me what you think."

Then shut up and watch.

---

## What to watch for

### The big one: does the leader run away with it?

[MULTIPLAYER_PLAN.md](MULTIPLAYER_PLAN.md) §11.6 flags a specific risk.
`CONQUEST_INCOME_BONUS` gives **+2 gold/second permanently for every base you
destroy, and it stacks**. The fear: whoever gets the first kill earns faster, so
gets the second kill more easily, and by minute eight one player is unstoppable
while seven people play out a decided match.

You don't have to guess. After the session:

```bash
docker compose -f docker-compose.playtest.yml run --rm server node ../loadtest/src/analyse.mjs
```

It reads what actually happened and tells you:

```
── Runaway leader? (the CONQUEST_INCOME_BONUS worry) ──
  first kill → won the match   7/9  (78%)
  (random chance would be ~13% with 8 players)
  ⚠ SNOWBALL CONFIRMED.

── Economy gap over time (leader vs median, XP) ───────
  min  2   1.4x  ██████
  min  4   2.1x  ████████
  min  6   3.8x  ███████████████
  min  8   6.2x  ████████████████████████
```

That last graph is the thing to look at. If the leader is at 6× the median by
minute 8, the match was over and everyone was still playing it.

**If it's confirmed**, the fixes are already worked out (§11.6), in order of
preference:

1. **Diminishing returns** — `+2, +1.5, +1.1, …` instead of flat `+2`. Simplest
   and most predictable.
2. **Leader bounty** — killing the top player pays more, so the lobby naturally
   turns on whoever is winning. This "everyone gangs up on first place" dynamic
   is one of the best things about free-for-all games; lean into it.
3. **Catch-up income** for players far below the median. Use carefully — if
   players can see it, it feels patronising.

All the tuning numbers live in one file: `packages/sim/constants.js`.

### The other things the analysis answers

| Output | What it means |
|---|---|
| **How matches ended** | Lots of timeouts means matches grind. Attacking may be too expensive or bases too tough. |
| **Time spent eliminated** | If the median dead player watches for 8 minutes, spectating isn't enough — they need to requeue instantly. |
| **Humans vs bots** | If bots keep winning, either they're too strong or the game isn't teaching newcomers anything. |
| **Player feedback** | Ratings and comments, tagged with whether that player won — "boring" from someone knocked out at minute three means something different from "boring" from the winner. |

### What only your eyes can catch

Sit next to someone if you can. Note every moment they:

- **ask a question** — that's a thing the interface should have told them
- **click something and nothing happens** — probably the 15-soldier rule; is it
  visible enough that a squad isn't ready yet?
- **go quiet and look bored** — when, and what was happening?
- **say "oh!"** — something finally clicked. What made it click?

The 15-soldier deploy rule is the mechanic I'd watch hardest. It gives the game
its rhythm and it's completely non-obvious to a new player.

---

## Feedback comes to you automatically

The scoreboard at the end of each match asks "How was that match?" — one tap,
1–5, optional comment. It's anonymous, needs no account, and every response is
tagged with whether they won, how long they survived, and their ping.

It arrives while the match is still fresh, which is when people say what they
actually felt rather than what they think you want to hear.

Everything lands in `./data/` on your machine:

```
data/matches.jsonl    one line per completed match, with economy over time
data/feedback.jsonl   one line per response
```

Those files persist across restarts. Keep them — comparing before and after a
balance change is how you know the change worked.

---

## After the session

1. **Run the analysis.** Start with the snowball question.
2. **Read the comments** alongside whether that player won.
3. **Change one thing at a time.** Every number is in
   `packages/sim/constants.js`. Change one, run another session, compare the
   analysis. Changing three at once teaches you nothing about which mattered.
4. **Run the tests** before you playtest again — `npm test` in Docker. The
   balance constants are covered by the golden-run test, so a change that
   breaks the simulation gets caught before eight people find it.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tunnel address never appears | `docker compose -f docker-compose.playtest.yml logs tunnel-server` — usually a slow first image pull |
| Players see the site but PLAY ONLINE fails | The client got the wrong server address. Ctrl-C and re-run `playtest.sh` — it wires them together in order |
| "Blocked request. This host is not allowed" | Vite host check. The playtest compose sets `VITE_ALLOWED_HOSTS=all`; make sure you're using that compose file |
| Nothing in `./data/` | Matches only record when they *finish*. Lower `MATCH_LIMIT_MS` |
| Server changes seem ignored | `docker compose -f docker-compose.playtest.yml restart server` — the watcher misses Windows bind-mount changes |
