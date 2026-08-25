# BaseWar.io — Multiplayer Plan (Explained From Scratch)

**What this document is:** a complete plan to turn your single-player game into an online multiplayer game, written so that someone who has never built a multiplayer game before can follow every decision and understand *why* it was made.

**Nothing here assumes prior knowledge.** Every technical term is defined the first time it appears. If you hit a word you don't recognise, check the Glossary in Part I, Section 1.

**How the document is organised:**

- **Part I — Understanding the problem** (Sections 1–4): the vocabulary, how multiplayer games actually work, and what your game looks like today.
- **Part II — The phases** (Sections 5–11): the actual plan, one phase at a time. Each phase says what you build, why, and how you know it's finished.
- **Part III — Money, the future, and your decisions** (Sections 12–14).

If you only read one part, read Part I Section 3 ("Multiplayer 101"). Everything else is a consequence of it.

---

# PART I — UNDERSTANDING THE PROBLEM

## 1. Glossary

Read this once, then refer back. Terms are grouped by topic rather than alphabetically, because they make more sense in clusters.

### 1.1 The basics

| Term | What it means |
|---|---|
| **Client** | The program running on the player's computer. In your case: the web page — PixiJS drawing the game, the HUD, the mouse handling. |
| **Server** | A program running on a computer you rent, that every player connects to. It's the referee: it decides what actually happened. |
| **Frontend / Backend** | Frontend = the client (what the player sees). Backend = the server plus supporting services (database, matchmaking). |
| **Latency / Ping / RTT** | How long a message takes to travel. "Ping 80ms" means a message takes 80 milliseconds to reach the server and come back (RTT = Round Trip Time). Physics sets a floor: India→Germany is ~120ms minimum, no matter how much you pay. |
| **Bandwidth** | How much data you send per second. Measured in KB/s (kilobytes per second). |
| **CCU** | Concurrent Users — how many people are playing **at the same moment**. Not total signups. 10,000 CCU is a genuinely successful game. |

### 1.2 How the game runs

| Term | What it means |
|---|---|
| **Tick** | One step of the game simulation. Your game currently ticks ~60 times/second (once per drawn frame). The server will tick 20 times/second. |
| **Tick rate / Hz** | Ticks per second. "20 Hz" = 20 ticks per second = one tick every 50 milliseconds. |
| **Fixed timestep** | Every tick advances the game by exactly the same amount of time (e.g. always 50ms). Your game currently uses a *variable* timestep — each tick advances by however long the last frame took. That's fine for single-player, bad for a server (see Phase 0). |
| **Simulation ("the sim")** | The pure game logic: movement, combat, gold income, levelling. No drawing, no mouse input. In your code this is everything in `src/game/systems/` plus `entities.js`, `walls.js`, `World.js`, `GameState.js`. |
| **Authoritative** | "The server's version is the truth." If your screen says you have 500 gold and the server says 400, you have 400. |

### 1.3 Networking

| Term | What it means |
|---|---|
| **WebSocket** | A way for a browser and a server to hold an open two-way conversation. Normal web pages work like letters (you request, server replies, connection closes). A WebSocket is like a phone call that stays open — either side can speak at any time. This is what every browser multiplayer game uses. |
| **WSS** | WebSocket Secure — the encrypted version, the same way HTTPS is the encrypted version of HTTP. Browsers require it for any site served over HTTPS. |
| **Command** | A message from client → server. "Move squad 4 to (1200, 900)." |
| **Snapshot** | A message from server → client describing the state of the world. "Soldier 42 is at (1180, 890) with 60% health." |
| **Room** | One match. 8 players in one game world. A server runs many rooms side by side, each completely independent. |
| **Interpolation** | Smoothing. The server sends positions 10 times per second, but you draw 60 times per second. Interpolation fills in the 50 missing frames by sliding smoothly between the two positions you *do* know. |
| **Client-side prediction** | The client guesses what the server will say and draws it immediately, so the game feels instant. Explained fully in Section 3.4. |
| **Reconciliation** | Fixing the guess when the server disagrees with your prediction. The hard part of multiplayer. |

### 1.4 Infrastructure

| Term | What it means |
|---|---|
| **Node.js** | A way to run JavaScript outside a browser — on a server. This is why your existing JavaScript game logic can run on the server *unchanged*. |
| **CPU core** | One "brain" inside a server computer. A machine might have 8 cores, meaning it can genuinely do 8 things at once. |
| **Process** | One running copy of a program. Node.js uses only **one core per process** — so on an 8-core machine you run 8 copies of your server program to use the whole machine. |
| **Egress** | Data **leaving** your server, i.e. everything you send to players. Cloud companies charge for this by the gigabyte. Incoming data is usually free. Think of a courier that charges for parcels sent out but not for post received. This turns out to be the single biggest cost in your entire project — see Section 12. |
| **CDN** | Content Delivery Network. A worldwide network of computers that store copies of your files so players download them from a nearby city rather than from one server. Makes page loads fast globally. |
| **Cloudflare Pages** | A free CDN service for hosting static websites (HTML/JS/CSS files that never change per-user). Your game client, once built, is exactly that. |
| **Hetzner / OVH** | European companies that rent server computers, much cheaper than Amazon/Google, especially for egress. |
| **AWS / GCP** | Amazon Web Services / Google Cloud Platform. The big cloud providers. Excellent, flexible, and *very* expensive for egress. |
| **Redis** | A very fast database that keeps everything in memory. Used here as a shared noticeboard so multiple servers can see each other's rooms. |
| **Postgres** | A traditional database that stores data permanently on disk. Used later for accounts and leaderboards. |
| **Docker** | A way to package your program with everything it needs so it runs identically on your laptop and on a rented server. You already have a `Dockerfile`. |

### 1.5 Tools and libraries

| Term | What it means |
|---|---|
| **Colyseus** | A free, open-source library for Node.js that handles the boring-but-hard parts of multiplayer game servers: creating and destroying rooms, putting players into them, handling disconnects and reconnects, and running several servers together. You still write your own game logic — Colyseus is the *building*, your simulation is the *tenant*. |
| **PixiJS** | The 2D drawing library your game already uses. Stays on the client, untouched. |
| **Vite** | The tool that bundles your source files into a website. You already use it. |
| **Monorepo** | One code repository containing several sub-projects (client, server, shared code) that can import from each other. |
| **Web Worker** | A background thread inside the browser. Lets you run heavy JavaScript without freezing the page. We'll use it to run the game simulation locally for single-player practice mode. |

### 1.6 Computer-science terms used later

| Term | What it means |
|---|---|
| **O(n²)** | "Order n squared." A way of describing how work grows with size. If you have `n` soldiers and each one checks every other soldier, you do `n × n` checks. Double the soldiers and the work goes up **four times**, not two. This is bad and it's what your combat code does today. Explained in Phase 3. |
| **Spatial hash / grid** | A technique to avoid O(n²). Divide the map into squares; each soldier only checks the few squares near it. Explained in Phase 3. |
| **Binary protocol** | Sending data as raw bytes instead of readable text (JSON). `{"x":1200,"y":900}` is 19 characters; the same thing in binary is 3 bytes. |
| **Quantization** | Deliberately reducing precision to save space. Instead of storing a position as `1200.4823719`, store it as `1200` — the difference is invisible on screen and saves bytes. |
| **Delta encoding** | Only sending what **changed** since the last message, instead of the whole world every time. |

---

## 2. What this project actually is

Right now your game works like this:

```
   Player's browser
   ┌────────────────────────────────────┐
   │  Everything happens here:          │
   │  • the player's base               │
   │  • 7 bot bases run by AISystem     │
   │  • all combat, gold, levelling     │
   │  • all drawing                     │
   │                                    │
   │  Nobody else is involved.          │
   └────────────────────────────────────┘
```

We want this:

```
   Player A's browser        Player B's browser       (…6 more)
   ┌──────────────┐          ┌──────────────┐
   │ Draws.       │          │ Draws.       │
   │ Sends orders.│          │ Sends orders.│
   └──────┬───────┘          └──────┬───────┘
          │  "move squad 3"         │  "attack base 5"
          │                         │
          └──────────┬──────────────┘
                     ▼
          ┌────────────────────────┐
          │   Game server          │
          │   Runs the simulation  │
          │   Decides what's true  │
          │   Tells everyone       │
          └────────────────────────┘
```

The important shift: **the browser stops being in charge**. Today the browser *is* the game. After this project, the browser is a screen and a keyboard — the real game lives on the server.

### Why the server has to be in charge

Suppose we let each browser run its own copy and just tell each other what happened. Two problems:

**Problem 1 — Disagreement.** Player A's browser thinks the squad reached the base. Player B's browser, running a fraction of a second behind, thinks it didn't. Both are "right" locally. There's no way to resolve it.

**Problem 2 — Cheating.** JavaScript in a browser is fully visible and editable. Any player can open developer tools and type `base.gold = 999999`. If the browser is in charge, that's the end of your game. If the server is in charge, that line changes a number on their screen for a fraction of a second and then the next server message overwrites it. Nothing happens.

This is why essentially every competitive online game uses an authoritative server. It isn't optional.

---

## 3. Multiplayer 101 — the fundamental problem

**This is the most important section in the document.** Everything else follows from it.

### 3.1 The problem

Light takes time to travel. A player in Mumbai talking to a server in Frankfurt has a round trip of roughly 120–150 milliseconds — that's physics, not engineering, and no amount of money fixes it.

So here's the conflict:

- **We want the server to decide everything** (so nobody cheats and everyone agrees).
- **But asking the server takes 150ms**, and a game that responds 150ms after every click feels broken.

Every multiplayer game ever made is some answer to that one conflict.

### 3.2 What 150ms actually feels like

It depends entirely on what you're controlling:

| You are controlling… | Does 150ms delay matter? |
|---|---|
| A character you move with WASD | **Yes, terribly.** It's like a mouse cursor that lags behind your hand. Unplayable. |
| A gun you aim and fire | **Yes.** You shoot where the enemy *was*, not where they are. |
| A squad you order to walk across a map over 8 seconds | **No.** 150ms out of 8,000ms is 2%. You cannot perceive it. |

Look at that last row. **That's your game.**

### 3.3 What your game actually asks the player to do

Go through the real list of player actions in your code:

| Action | Where in the code | How often? | How fast must it respond? |
|---|---|---|---|
| Queue a soldier | `Game._enqueueUnit` | A few times/minute | Instantly-ish, but it's just a UI badge |
| Buy a mining upgrade | `Game.js` mine button | Rarely | Same |
| Spend a skill point | `Game.js` skill panel | Rarely | Same |
| Move a squad | `InputSystem` → `moveGroup` | A few times/minute | Squad walks for seconds |
| Attack a base | `InputSystem` → `attackWithGroup` | Rarely | Squad walks for seconds |
| Release the garrison | `Game._releaseGarrison` | Occasionally | Instant-feeling, but it's one event |

There is **no action in your entire game that requires sub-100ms response.** A busy player issues maybe one to three commands per second, and every one of them starts something that takes seconds to play out.

This is enormously lucky, and it's not an accident — it's a consequence of the design decision that the player commands *squads*, not a character. That decision, made for gameplay reasons, happens to also be the single best thing about this game from a networking perspective.

### 3.4 Client-side prediction — the thing you asked about

Let me explain the concept properly, because you plan to add player avatars later (Section 13) and then you *will* need it.

**The scenario where you need prediction:** imagine a game where you move a character with WASD.

Without prediction:

```
t=0ms     You press D (move right)
t=0ms     Browser sends "pressed D" to server
t=75ms    Server receives it, moves your character right
t=150ms   Browser receives "you are now at x=105"
t=150ms   Your character finally appears to move
```

You press a key and 150ms later something happens. Every player would immediately call this game broken.

**With prediction:**

```
t=0ms     You press D
t=0ms     Browser sends "input #1: pressed D" to server
t=0ms     ALSO: browser immediately moves your character right on screen ← the prediction
          and remembers "at input #1 I predicted x=105"
t=150ms   Server replies: "after input #1, you are at x=105"
t=150ms   Browser compares: I predicted 105, server says 105. They match.
          Nothing visible happens. The player never knew.
```

The character responded instantly, and the server is still the authority. Beautiful.

**Now the hard part — reconciliation.** What if the server *disagrees*?

```
t=0ms     You press D. Browser predicts x=105.
t=10ms    You press D again. Browser predicts x=110.
t=20ms    You press D again. Browser predicts x=115.
t=150ms   Server replies about input #1: "you are at x=100 — a wall stopped you.
          (The client didn't know about the wall, or you got stunned, or
           another player pushed you.)"
```

Now the client is showing x=115 but the truth was x=100 three inputs ago. It cannot just snap to 100 — that would rubber-band you backwards and also throw away inputs #2 and #3 which you legitimately made.

So it must:
1. Snap back to the server's position (x=100).
2. **Re-run** inputs #2 and #3 locally from that corrected starting point.
3. Arrive at a new corrected prediction and draw that.

That replay step is **reconciliation**. It requires:
- keeping a buffer of every input you sent and haven't had confirmed yet,
- being able to re-run the movement logic identically on the client and the server,
- doing all of it every single frame without visible glitching.

This is where multiplayer games get their famous bugs: rubber-banding, teleporting, "I definitely shot him", hitboxes that feel wrong. It is genuinely the hardest part of the craft, and it's the reason multiplayer shooters take years to feel good.

### 3.5 So — what did I mean about your game?

**Your game has nothing to predict.**

You don't control anything that moves under your finger. You issue an order, and a squad — which is *not* you, which takes seconds to respond, and which the server owns entirely — carries it out. There is no moment where the player's hand and the screen must feel connected.

So you skip prediction, and you skip reconciliation, and you skip the entire class of bugs that comes with them. Instead you use two much simpler techniques:

**Technique 1 — Interpolation (smoothing).** The server sends positions 10 times per second; you draw 60 times per second. So you deliberately draw the world **100 milliseconds in the past**, sliding smoothly between the two snapshots you already have on either side of that moment. Because you're rendering a moment that's already fully known, movement is perfectly smooth. Nobody notices the 100ms because there's nothing to compare it against.

**Technique 2 — Optimistic UI feedback.** When the player clicks "move here", draw the destination marker *immediately*, in a faded colour. When the server's confirmation arrives 150ms later, the marker turns solid. The player gets instant acknowledgement that the click registered, while the actual game state stays 100% server-controlled.

That's about twenty lines of code, versus several weeks for a prediction/reconciliation system. **This is why I said the hardest part of multiplayer doesn't apply here.**

*(And when you add avatars later — that's Section 13. The good news is that the architecture in this plan doesn't have to change to support it.)*

### 3.6 Commands down, snapshots up: the shape of all traffic

Putting it together, here's the entire networking model:

```
CLIENT                                    SERVER
  │                                          │
  │  ── "move squad 3 to (1200,900)" ──────► │   rare, tiny messages
  │  ── "queue a grunt" ─────────────────►   │   (a few per second at most)
  │                                          │
  │                                          │  ticks 20×/sec, runs the sim
  │                                          │
  │  ◄──── snapshot of the world ─────────   │   10×/sec, ~1.5 KB each
  │  ◄──── snapshot of the world ─────────   │
  │  ◄──── "these 3 soldiers died" ───────   │   events, as they happen
  │                                          │
```

Upstream (client→server) is almost nothing. Downstream (server→client) is where all the data is, and it's the thing we'll spend real effort optimising, because it's the thing you pay money for.

---

## 4. What you have today

I read all 5,800 lines. Here's the honest assessment.

### 4.1 The best news: your game logic is already server-ready

I searched every file for browser-only features (`document.`, `window.`, PixiJS imports). Here's what I found:

**Files that touch the browser** — these stay in the client and don't go to the server:

| File | What it does |
|---|---|
| `src/main.js` | Page startup, menu buttons |
| `src/game/Game.js` | Creates the PixiJS canvas, wires up HTML buttons |
| `src/game/systems/InputSystem.js` | Mouse clicks, keyboard, drag-select box |
| `src/game/renderer/GameRenderer.js` | Draws the world |
| `src/game/renderer/HUDRenderer.js` | Updates the HTML interface |

**Files with ZERO browser dependencies** — these can run on a server *right now*, unchanged:

| File | What it does |
|---|---|
| `constants.js` | All the tuning numbers |
| `entities.js` | Base, Soldier, Group, Turret, Wall definitions |
| `walls.js` | Wall ring logic |
| `World.js` | Builds the 8-base map |
| `GameState.js` | Holds all the entities |
| `systems/CombatSystem.js` | All fighting |
| `systems/GroupSystem.js` | Squad formations and movement |
| `systems/ProductionSystem.js` | Building soldiers and walls |
| `systems/ProgressionSystem.js` | Gold, XP, levels |
| `systems/AISystem.js` | The bot brains |
| `systems/CenterSystem.js` | (currently disabled) |
| `systems/MiningSystem.js` | Mine node capture |
| `utils/helpers.js` | Maths helpers |

**Why this matters so much:** in most projects, game logic and drawing code are hopelessly tangled together — a soldier object holds a reference to its sprite, combat code triggers animations directly, and separating them is a month of dangerous surgery. Yours is already clean. Whoever built this made the right structural choice, and it saves you roughly three weeks.

### 4.2 Second-best news: you already have a bot player

`AISystem.js` drives 7 rival bases. It queues units, manages gold, decides when to release the garrison, and commits squads to attacks — all through **exactly the same state changes a human player makes**.

On a server, this one file solves four separate problems for free:

1. **Empty lobbies.** A new game with 2 real players and 6 bots feels full. Without this, your first month — when few people are online — would look like a dead game, and players who see a dead game don't come back.
2. **Disconnects.** Someone's WiFi dies. Instead of their base sitting frozen as a free kill, the AI takes over. Their allies aren't abandoned; their enemies don't get a gift.
3. **AFK players.** Same mechanism.
4. **Load testing.** A room full of bots is a realistic CPU workload, so you can measure server capacity without recruiting 500 humans.

Most teams have to build this from scratch. You have it working already.

### 4.3 The things that must change

These aren't criticisms — they're all completely normal single-player choices that stop being valid on a server.

#### (a) Entity IDs grow forever

In `src/utils/helpers.js`:

```js
let _id = 0;
export const uid = () => `e${++_id}`;
```

Every soldier, base and squad gets a name: `e1`, `e2`, `e3`… so messages can refer to them ("soldier e42 died").

The counter lives at the top of the file, which in Node.js means **one counter shared by every match running in that program**. Room 1 uses e1–e400, Room 2 continues at e401, and so on — forever, for as long as the server is running.

*(I want to correct something I said in my first summary: I claimed two rooms would produce colliding IDs. That's wrong — because the counter is shared and only ever increases, IDs stay unique. The real problem is different, and it's below.)*

**The actual problem: the numbers get too big for the compact message format.**

To keep bandwidth low, we want to refer to each entity using **2 bytes** — which can hold numbers from 0 to 65,535. That's plenty for one match, which never has more than ~2,000 things in it at once.

But with a shared, forever-increasing counter: 30 rooms per process × ~400 soldiers created per room per minute means about 12,000 new IDs every minute. You blow past 65,535 in **five minutes of server uptime**. After that, IDs would wrap around and start pointing at the wrong entities — soldiers appearing to teleport, damage applied to the wrong unit, chaos.

You could use 4 bytes instead, but entity IDs appear several times in every snapshot, so that quietly doubles a big chunk of your bandwidth bill.

**The fix:** give each room its own counter, and recycle IDs when entities die. Then no room ever exceeds ~2,000, 2 bytes is comfortable forever, and each room becomes fully self-contained. Small change, and it also makes the code cleaner. Do it in Phase 0.

#### (b) The game speed depends on the frame rate

In `Game.js`:

```js
const dtMs = Math.min(this._app.ticker.elapsedMS, 50);
```

`dtMs` is "how long since the last frame". On a fast computer that's ~16ms; on a slow one it might be 40ms. The game then advances by that amount.

That's fine when you're playing alone. On a server it's not, because the game must advance at exactly one rate for everybody. If the server is briefly busy and a tick takes 60ms instead of 50ms, the game must **not** silently speed up to compensate — that would make combat outcomes depend on server load.

**The fix:** a fixed timestep. The server advances the game by exactly 50ms every tick, no matter how long the tick actually took in real time. If the server falls behind, it runs two ticks back to back to catch up.

#### (c) Selection is stored on the shared game object

In `entities.js`, the `Group` class has `this.selected = false`.

Single-player: fine, there's one player. Multiplayer: if selection is part of the shared world, then when Player A selects a squad, that fact gets sent to everyone, and Player B's screen would draw a selection ring around a squad they didn't select.

**The fix:** selection is not game state, it's *interface* state. It moves out of the shared entity and into a client-side list of "squad IDs I currently have selected". Never sent over the network.

#### (d) The client changes the game directly

Right now, when you click "buy mining upgrade", the client calls `buyMineUpgrade()` and the gold number goes down immediately, in the same function.

Multiplayer: the client can't be allowed to do that. Every one of these has to become a *request* — "I would like to buy a mining upgrade" — that the server validates and applies.

There are 12 such places. The full list is in Phase 1.

#### (e) Combat checks everything against everything

`CombatSystem._skirmish()` loops over every soldier, and for each one loops over every other soldier to find the nearest enemy. That's the O(n²) problem from the glossary, and it's explained properly in Phase 3 with the fix.

For single-player it's fine — one match, modern computer, no problem. On a server running 30 matches at once, it's the difference between renting 2 servers and renting 12.

#### (f) Errors are hidden

In `Game.js`:

```js
try { this._step(delta); }
catch (err) { console.error(...); /* game continues */ }
```

For a single player this is kind — a small bug doesn't end their game. On a server it's dangerous: a match could break in minute 2 and keep quietly running wrong for 18 more minutes, for 8 players, and nobody would find out.

**The fix:** log it properly with the room ID and tick number, count it in monitoring, and if a room keeps failing, end it cleanly and tell the players — rather than letting them play a broken match.

### 4.4 Design choices you should NOT change

Some of your existing rules are unusually well suited to multiplayer, and it's worth naming them so nobody "improves" them later:

- **Squads must reach 15 soldiers before they can deploy** (`canDeploy` in `GroupSystem.js`). This gives the game a build-up → commit → resolve rhythm. It stops the frantic click-spam that makes competitive strategy games hostile to newcomers, and it's a major reason latency doesn't matter here.
- **The garrison.** Holding soldiers inside the base and releasing them as one formation is a real decision under pressure: hold and risk your base, or release early and get picked apart. Against a human opponent this is much more interesting than against a bot.
- **Defender's advantage** (`DEFENDER_ATK_MULT`, `DEFENDER_DMG_TAKEN`). Attacking costs you more than defending. Against humans this is *essential* — without it, whoever attacks first always wins, and the game becomes a coin flip.

---

# PART II — THE PHASES

## 5. The plan at a glance

| Phase | Name | Time | What you get at the end |
|---|---|---|---|
| **0** | Split the brain from the body | 1 week | Nothing looks different — but the game logic now runs separately from the drawing |
| **1** | First real multiplayer match | 2 weeks | 8 people can play a real match together |
| **2** | Make it a game service | 1 week | A stranger visits the URL and is playing in 10 seconds |
| **3** | Make it fast | 1 week | You know exactly how many matches one server can hold |
| **4** | Go live | 1 week | **Publicly playable, monitored. Launch at 100 players.** |
| **5** | Grow to 10,000 | 2 weeks | Multiple servers, accounts, leaderboards |
| **6** | *(Future)* Player avatars | separate project | Discussed in Section 13 |

**Total to launch: about 5 weeks. Total to 10,000-capable: 7–8 weeks.** One experienced developer.

A note on ordering: it's tempting to skip Phase 0 and just bolt a WebSocket onto `Game.js` — you'd have something moving in three days. Don't. That path leaves game logic and drawing code tangled together, and every phase afterwards pays interest on it. Your code is *already* almost separated (Section 4.1); Phase 0 just makes it official.

---

## 6. PHASE 0 — Split the brain from the body

**Duration:** 1 week
**Visible change to players:** none whatsoever
**Why it exists:** everything else depends on it

### 6.1 The goal

Right now your game logic and your drawing code live together in one folder and one program. We're going to separate them into:

- **The simulation** — pure game rules. Runs anywhere: in a browser, on a server, in a test script. Knows nothing about pixels.
- **The client** — drawing, mouse, HTML interface. Knows nothing about game rules.

The simulation becomes a shared package that *both* the browser and the server will use. Same code, same rules, no chance of them drifting apart.

### 6.2 Why this matters (the analogy)

Think of a chess program. There's the **rules engine** (what moves are legal, is this checkmate) and the **board display** (drawing the pieces). If those are mixed together, you can never run a chess server — because the rules are trapped inside the drawing code.

You want the rules engine to be a self-contained thing you can pick up and run anywhere. That's Phase 0.

The lovely part, as Section 4.1 showed: your rules engine is **already** free of drawing code. We're mostly moving files and drawing a clean line, not rewriting logic.

### 6.3 The new folder structure

```
basewar.io/
├── packages/
│   ├── sim/              ← THE RULES ENGINE (moved from src/game)
│   │   ├── constants.js       (unchanged)
│   │   ├── entities.js        (unchanged)
│   │   ├── walls.js           (unchanged)
│   │   ├── World.js           (unchanged)
│   │   ├── GameState.js       (unchanged)
│   │   ├── systems/           (all 7, unchanged — NOT InputSystem)
│   │   └── Simulation.js      ← NEW: the wrapper
│   │
│   └── protocol/         ← message definitions, shared by client and server
│
└── apps/
    └── client/           ← Vite + PixiJS (the existing game, minus the rules)
```

`packages/` holds shared libraries. `apps/` holds runnable programs. In Phase 1 we add `apps/server/`.

This is called a **monorepo** — one repository, several sub-projects that can import from each other. We'll use `pnpm workspaces`, which is the standard, simple tool for this.

### 6.4 The one new file: `Simulation.js`

This is the seam — the single doorway into the rules engine. Both the server (Phase 1) and the browser's practice mode will create one of these and nothing else.

```js
export class Simulation {
  constructor(mode, seatCount) {
    // builds the world, creates a PER-INSTANCE id counter (fixes 4.3a)
  }

  applyCommand(seat, command) {
    // The ONLY way anything is allowed to change the game.
    // Validates: does this player own that squad? can they afford it?
    // Returns true/false.
  }

  step(fixedDtMs) {
    // Advances the game by exactly fixedDtMs.
    // Runs the seven systems in today's order:
    //   progression → production → ai → center → mining → group → combat
  }

  drainEvents() {
    // Returns things that happened this tick: kills, level-ups, eliminations.
  }

  getStateForNetwork() {
    // Returns plain data, ready to be packed into a snapshot.
  }
}
```

Note `applyCommand` — that's the rule that makes multiplayer possible. **Nothing changes the game except through this one method.** Once that's true, putting a network in front of it is straightforward.

### 6.5 Tasks

1. Set up the pnpm workspace with `packages/` and `apps/`.
2. Move the 13 browser-free files into `packages/sim/`. Fix the import paths.
3. **Fix `uid()`** (Section 4.3a): make the counter belong to each `Simulation` instance rather than the file, use plain numbers instead of `"e42"` strings, and recycle IDs when entities die. Write a test proving two simulations running side by side both stay under 2,000 IDs.
4. Write `Simulation.js` with the four methods above.
5. Move `Group.selected` out of the entity into a client-side `Set` of selected squad IDs. Update `GameRenderer` (line ~391) and `HUDRenderer` (line ~132) to read from it.
6. Convert all 12 direct-mutation sites into `applyCommand()` calls. For now they call it directly — no network yet.
7. Replace the variable timestep with a fixed 50ms step (Section 4.3b).
8. Replace the silent `try/catch` with proper logging (Section 4.3f).
9. **Move the simulation into a Web Worker** — a background thread in the browser. The client now talks to the simulation by sending messages, exactly as it will talk to a server later.

### 6.6 Why step 9 is clever

Once the simulation runs in a Web Worker and the client talks to it by messages, you build a small abstraction:

```js
// Both of these do the same job. The rest of the client can't tell them apart.
class WorkerConnection    { /* talks to the local Web Worker  */ }
class WebSocketConnection { /* talks to a real remote server  */ }  // Phase 1
```

Two consequences, both valuable:

1. **Single-player practice mode costs you nothing.** It runs entirely in the player's own browser — zero server CPU, zero latency, zero hosting cost. When you have 10,000 players, the ones just practising against bots cost you literally $0.
2. **Practice and online can never drift apart.** They run the same code through the same doorway. A balance change applies to both automatically.

You get single-player and multiplayer from one codebase, permanently.

### 6.7 Done when

- The game plays **exactly** as it does today — same feel, same balance, no visible difference.
- The simulation is running in a Web Worker, communicating only by messages.
- `packages/sim` has no reference to `document`, `window`, or PixiJS anywhere.
- Two simulations can run side by side in one program without interfering.

---

## 7. PHASE 1 — First real multiplayer match

**Duration:** 2 weeks
**Visible change:** 8 real people can play together
**This is the exciting one.**

### 7.1 The goal

Put the simulation on a real server, connect browsers to it over the internet, and play a full match with real humans.

### 7.2 Introducing Colyseus

Building a game server from scratch means writing all of this yourself:

- accepting WebSocket connections and tracking who's who
- grouping players into matches and keeping matches separate
- creating a match when needed, destroying it when it ends
- detecting disconnects, allowing reconnection within a grace period
- later: running several server machines and knowing which match is on which

That's several weeks of work, and none of it is your game.

**Colyseus** is a free, open-source Node.js library that does exactly that list. You write a "Room" class containing your game; Colyseus handles everything around it.

The analogy: Colyseus is the **cinema building** — the box office, the numbered screens, the ushers, the fire exits. Your simulation is the **film**. You want to make films, not pour concrete.

**Why Colyseus specifically:**

| | |
|---|---|
| Built for this exact thing | It's designed for room-based browser multiplayer games. Not adapted — designed. |
| Free | MIT licence. No fees, ever, at any scale. |
| Your code fits | It's Node.js, so your existing JavaScript simulation drops in unchanged. |
| Community | Large active Discord, good documentation, many shipped games. When you're stuck at 1am, someone has hit your problem before. |
| Scales when you need it | The multi-server support you'll need in Phase 5 is built in. |

**Alternatives I considered and rejected:**

| Option | Why not |
|---|---|
| Write it yourself with the `ws` library | 3–4 extra weeks rebuilding what Colyseus gives you free. Sensible only if Colyseus proves too slow — Section 7.4 explains why it won't. |
| socket.io | Popular, but its "rooms" are chat channels, not game matches. Its compatibility fallbacks are dead weight — every browser has supported WebSocket for a decade. |
| geckos.io (WebRTC/UDP) | Uses a faster, less reliable transport. Genuinely helps twitch shooters. Your game tolerates 150ms happily (Section 3.3), so you'd add real complexity and extra server costs for a benefit nobody can perceive. |
| Nakama (Go language) | Good software, but the game loop would have to be rewritten in Go — throwing away 2,500 lines of working, tuned JavaScript. |
| Cloudflare Durable Objects | Genuinely interesting: no servers to manage and free egress. But it bills by running time, and a game room runs continuously — roughly **$4 per room per month**, so ~$5,200/month at 10,000 players versus ~$1,000 on rented servers. Worth revisiting only if managing servers becomes more painful than the extra cost. |

### 7.3 What the room does

```js
class ArenaRoom extends Room {
  onCreate() {
    this.sim = new Simulation('ffa', 8);   // from Phase 0
    this.setSimulationInterval(() => this.tick(), 50);  // 20 times per second
  }

  onJoin(client)  { /* give them a free seat, or take over a bot's base */ }
  onLeave(client) { /* hand their base to the AI; allow 90s to reconnect */ }

  onMessage(client, command) {
    this.sim.applyCommand(client.seat, command);   // validated inside
  }

  tick() {
    this.sim.step(50);                    // advance the game exactly 50ms
    const events = this.sim.drainEvents();
    if (this.tickCount % 2 === 0) {       // every other tick = 10 times/second
      this.broadcast(encodeSnapshot(this.sim), events);
    }
    this.checkRoundEnd();
  }
}
```

That's genuinely close to the real thing. The simulation you built in Phase 0 does the work; the room is a thin wrapper.

### 7.4 How we send the world — and one clever trick

This is the part that decides your monthly bill, so it's worth understanding.

**The naive approach:** every 10th of a second, send every soldier's position to every player.

- ~400 soldiers × 8 bytes each = 3.2 KB per snapshot
- × 10 snapshots/second = **32 KB/second per player**
- × 8 players = 256 KB/second per match

That works, but it's more than we need to pay.

**The trick: your soldiers move in rigid formations.**

Look at `GroupSystem._slotPos()`. A soldier's target position is calculated purely from three things: its squad's anchor point, the squad's facing direction, and the soldier's index in the formation. Given those, the position is completely determined — it's just triangle maths.

Which means **the client can calculate it too**. We don't have to send soldier positions at all most of the time. We send:

- **The squad anchor points** (10×/second) — about 40 squads × 12 bytes = **480 bytes**
- **Actual soldier positions** (only 3×/second) — as a correction, because soldiers walking to their slot or fighting drift away from the perfect triangle
- **Events** as they happen — deaths, spawns, wall damage

Between corrections, the client runs the same slot-position maths and moves each soldier toward where it should be. The formation looks completely smooth, and bandwidth drops to roughly **12–18 KB/second per player** — a bit better than half the naive cost.

Since bandwidth is your dominant expense at scale (Section 12), that halving translates directly into money saved every month, forever.

**Also: quantization.** A position like `1247.8391` is stored as a decimal number taking 4 bytes per axis. But your map is 2,800 pixels wide and the default camera shows the whole map on screen — so one world pixel is smaller than one screen pixel. Storing the position to the nearest 0.68 pixels is *literally invisible*, and takes 12 bits instead of 32. We pack X and Y together into 3 bytes instead of 8.

**Why Colyseus won't be a bottleneck.** Colyseus has a built-in system (`Schema`) that automatically detects and sends changes. It's excellent for things that change rarely and does more work than we want for 400 soldiers that move constantly. So we use both:

- **Colyseus `Schema`** for slow-changing things: player names, base HP, gold, level, walls, round phase. Automatic change-detection is a pure win here.
- **Our own binary format** for soldiers and squads. Full control over every byte.

Best of both. This is why "Colyseus is too slow for lots of entities" — a real concern people raise — doesn't apply to us.

### 7.5 What the client sends

Every player action becomes a small message. These are so infrequent that plain JSON is fine.

```
{ t:'queue',      unit:'grunt', n:1 }        ← queue a soldier
{ t:'queue',      unit:'grunt', n:-1 }       ← remove one from queue
{ t:'mine' }                                 ← buy mining upgrade
{ t:'skill',      stat:'atk' }               ← spend a skill point
{ t:'spec',       choice:'bastion' }         ← choose specialization
{ t:'release' }                              ← release the garrison
{ t:'move',       g:[3,7], x:1200, y:900 }   ← move squads 3 and 7
{ t:'attack',     g:[3], target:12 }         ← attack entity 12
{ t:'defend',     g:[3] }
{ t:'defendNode', g:[3], node:5 }
{ t:'split',      g:3 }
{ t:'merge',      g:3 }
{ t:'balance' }
{ t:'donate',     g:3, to:5 }                ← team mode: give a soldier
{ t:'ping',       x:1200, y:900, kind:'attack' }
```

The 12 places in the client that currently change the game directly, all of which become one of these messages:

| Where | What it does today |
|---|---|
| `Game.js` ~line 83 | applies specialization |
| `Game.js` ~line 104 | buys mining upgrade |
| `Game.js` ~line 116 | spends a skill point |
| `Game.js` ~line 127 | releases the garrison |
| `Game.js` ~line 323 | adds to build queue |
| `Game.js` ~line 334 | removes from build queue |
| `Game.js` ~line 347 | queues a turret |
| `InputSystem.js` ~line 198 | attack order |
| `InputSystem.js` ~line 203 | garrison a mine node |
| `InputSystem.js` ~line 207 | move order |
| `InputSystem.js` ~line 223 | donate a soldier |
| `InputSystem.js` ~lines 241–266 | split / merge / balance / defend |

Things that stay purely local and are never sent: camera position and zoom, which squads you have selected, which HUD panels are open, mouse hit-testing.

### 7.6 Tasks

1. Create `apps/server` with Colyseus and an `ArenaRoom`.
2. Define the command messages in `packages/protocol` so client and server can't disagree about them.
3. Implement `applyCommand` validation properly: is this seat alive? do they own that squad? can they afford it? is the target legal?
4. Write the binary snapshot encoder (server) and decoder (client).
5. Client: replace the Worker connection with a WebSocket connection (the abstraction from Phase 0 makes this a small change).
6. Client: build the interpolation buffer — render 100ms in the past, smoothly.
7. Client: implement slot-position steering between snapshots.
8. Client: optimistic markers on order — faded, then solid on confirmation.
9. Server: bots fill every empty seat.
10. Server: disconnect → AI takeover; reconnect within 90 seconds → resume.

### 7.7 Done when

8 people on 8 different computers play a complete match on a test server, and it feels good.

### 7.8 What can go wrong

| Risk | What to do |
|---|---|
| Soldier movement looks jerky | Almost always the interpolation buffer being too short. Try 150ms. |
| Snapshots bigger than expected | Measure first. Delta encoding (only send what changed) is held in reserve for Phase 3 — don't build it speculatively. |
| A command works locally but is rejected by the server | This is the system working correctly. Make sure the client shows *why* (not enough gold, squad not full yet). |

---

## 8. PHASE 2 — Make it a game service

**Duration:** 1 week
**Goal:** a stranger opens the URL and is playing within 10 seconds

Phase 1 gives you a match. Phase 2 gives you a *game* — one people can find, join, finish, and immediately play again.

### 8.1 Matchmaking

**Matchmaking** = putting players into matches. Colyseus provides the mechanism; you decide the policy.

The policy that matters most: **never make people wait.** A player who lands on your site and sees "Waiting for players: 2/8" will leave. Because you have bots, you don't have to make them wait — start immediately with bots and let humans replace them as they arrive.

```
Player clicks PLAY
  → server finds a room with a free seat (or makes one)
  → player joins, gets a base, starts playing
  → total time: under 5 seconds
```

### 8.2 Match lifecycle

```
LOBBY   (up to 30 seconds, or instantly if 8 humans are queued)
   ↓
LIVE    (the match — max 20 minutes)
   ↓
ENDED   (15-second scoreboard)
   ↓
gone    (players auto-requeue into a new match)
```

**Why a 20-minute cap?** Today the match ends when one base remains. Against bots that resolves. Against cautious humans, three players could turtle behind walls indefinitely and the match never ends. So: at 20 minutes, highest total XP wins.

There's a happy accident here. `BOSS_INTERVAL` is 15 minutes, so in a 20-minute match **exactly one boss appears**, five minutes before the end, and becomes a dramatic final swing. That's good pacing — keep it.

A second happy accident: the 20-minute cap means you can deploy new server versions without ever kicking anyone. New matches go to the new version; old matches drain naturally within 20 minutes. Zero-downtime updates for free.

### 8.3 Joining a match already in progress

Someone joining at minute 12 next to a level-18 player is dead immediately. Three protections:

1. **Longer spawn protection for late joiners.** Today it's a flat 20 seconds (`SPAWN_PROTECT`). Make it `20s + 2s per minute of match age`, capped at 60s.
2. **Pick their position wisely** — the free base slot furthest from the strongest living player.
3. **A little starting gold** scaled to match age, so they can field a first squad rather than being helpless.

If no slot is free, they take over the **weakest bot's** base, inheriting its state. Instant entry, and it's a handicap they implicitly accepted by joining late.

### 8.4 When you're eliminated

Currently: a "game over" screen. In multiplayer you want:

- **Spectate** — keep watching the match. This is trivially easy for you: the camera already shows the whole map, so "spectating" just means "stop accepting commands from this player".
- **Requeue** — one button to join a fresh match immediately.

### 8.5 Talking to other players — pings, not chat

Recommendation: a small fixed set of map pings ("attack here", "defend", "help", "retreat"), not free text chat.

**Why:** text chat at 10,000 players means profanity filtering, a reporting system, moderators, and legal exposure around minors. That's an entire workstream. Pings give you roughly 90% of the coordination value for about 1% of the cost. Add chat later only if players genuinely demand it.

### 8.6 Tasks

1. Lobby screen with matchmaking and a countdown.
2. Round lifecycle state machine (lobby → live → ended).
3. 20-minute cap with XP-based winner.
4. Late-join slot selection and scaled spawn protection.
5. Spectate mode after elimination.
6. End-of-round scoreboard + one-click requeue.
7. Player names (nickname stored in the browser, no account needed) shown on bases and the leaderboard.
8. Map pings.
9. Connection quality indicator (ping display, "reconnecting…" state).

### 8.7 Done when

Someone you've never met can open the URL, be playing within 10 seconds, finish a match, and start another without ever seeing a loading screen they had to wait through.

---

## 9. PHASE 3 — Make it fast

**Duration:** 1 week
**Goal:** know exactly how many matches one server can hold

Up to now, correctness. Now, capacity — because capacity is what determines your bill.

### 9.1 The O(n²) problem, explained properly

Open `CombatSystem._skirmish()`. Simplified, it does this:

```js
for (const soldier of allSoldiers) {          // 400 soldiers
  for (const other of allSoldiers) {          // × 400 soldiers
    if (isEnemy && closeEnough) { ... }       // = 160,000 checks
  }
}
```

For each soldier, it looks at every other soldier to find the nearest enemy.

- 400 soldiers → 400 × 400 = **160,000 distance checks per tick**
- At 20 ticks/second → **3.2 million checks per second, per match**
- And `_enemyNear`, `_baseShielded`, `_threatNearBase`, `_nearestDefender` and `_enforceWalls` each do their own full scans on top

**Why "n squared" is the scary part.** If you double the soldiers to 800:

- Work doesn't double — it goes up **four times** (800 × 800 = 640,000)
- Triple the soldiers → nine times the work

That's what O(n²) means, and it's why this must be fixed before you rent servers.

### 9.2 The fix: a spatial grid

**The analogy.** You're in a stadium of 50,000 people looking for your friend.

- *Naive:* check every seat. 50,000 checks.
- *Smart:* your friend says "I'm in Section C, Row 12." Check that section only. ~200 checks.

That's a spatial grid. We divide the 2,800-pixel map into squares of 128 pixels, giving a 22 × 22 board. Every tick, each soldier registers which square it's in — that's 400 cheap operations.

Now when a soldier asks "any enemies within 210 pixels?", instead of checking all 400 soldiers, it checks only the squares that could possibly contain something in range — about 4×4 = 16 squares, typically holding 5–15 soldiers total.

**400 checks becomes ~10 checks. Roughly 10–30× faster on the combat step.**

Why 128 pixels? The largest search radius in your code is 280 (`DEFENSE_RADIUS`), and the biggest soldier detection radius is 210 (`autoR` for sentinel). Cells should be roughly the size of a typical query radius — too small and you check many empty cells; too big and each cell holds too many soldiers. 128 is a good starting point; tune it after measuring.

**What this is worth in money.** Roughly the difference between **5 matches per CPU core and 30**. At 10,000 players (1,250 matches), that's the difference between renting ~250 cores and ~42 cores — several thousand dollars a month, from one week's work.

### 9.3 Other speed work

- **Encode each snapshot once, not eight times.** All 8 players see the same world (whole-map camera), so build the message once and send the same bytes to everyone.
- **Reuse memory.** Allocate the snapshot buffer once per room and refill it, rather than creating a new one 10 times a second. Creating and discarding memory constantly makes the JavaScript garbage collector run, which causes stutters.
- **Skip `CenterSystem` entirely.** Look at it — the `update()` method immediately returns; eatables and wildlings are disabled in every mode. Don't pay to call it 20 times a second in 1,250 rooms.
- **Dense arrays instead of `Map` in hot loops.** JavaScript `Map` iteration is slower than plain array iteration. Worth doing only where profiling shows it matters — don't do it blindly.

**Target: 99% of ticks complete in under 10 milliseconds.** You have a 50ms budget per tick, so 10ms leaves comfortable headroom for spikes.

### 9.4 Load testing — the most important task in this phase

Everything about capacity so far is an *estimate*. Now you measure.

Build `apps/loadtest`: a program that pretends to be a player. It connects with the real protocol and issues random-but-legal commands at a human-like rate. Then run more and more of them:

```
1 room     → measure
10 rooms   → measure
50 rooms   → measure
200 rooms  → measure
```

Record at each step: tick time (99th percentile), memory used, bandwidth per player, CPU per core.

At some point one of those numbers goes bad. That point is your real capacity per server, and **every cost number in Section 12 depends on it.** Do this before you commit to a hosting shape.

### 9.5 One thing you cannot do (and why)

Most `.io` games save bandwidth using **interest management** — only sending each player the entities near their screen. If you can only see 20% of the map, you only receive 20% of the data.

**Your game can't do this.** The camera deliberately shows the whole map (`cam.zoom = width / WORLD_SIZE` in `Game.js`). Every player legitimately needs to know about every entity, all the time.

Three options:

1. **Accept it.** With the formation trick from Phase 1, ~15 KB/s per player is fine on a cheap-bandwidth host. **This is the recommendation.**
2. **Level of detail.** Send far-away soldiers less often and less precisely. Saves ~40%, but only helps when the player is zoomed in. Add later if measurements justify it.
3. **Add fog of war.** Would fight your whole design — the readable whole-map view is a strength. Not recommended.

*(This changes if you add avatars with a zoomed-in camera — see Section 13.)*

### 9.6 Done when

- 50+ matches run on one 8-core machine with 99% of ticks under 10ms.
- You have a real, measured number for "matches per core".
- Bandwidth per player is measured, not estimated.

---

## 10. PHASE 4 — Go live

**Duration:** 1 week
**Goal:** publicly playable and properly monitored, at 100 players

### 10.1 Frontend and backend go to different places

You asked whether frontend and backend could be separate. **Yes — and they should be**, because they have completely different needs.

**The frontend** (your game's HTML, JavaScript, images) is identical for every player and never changes between requests. That's called a *static site*, and it should live on a **CDN** — a worldwide network of computers that keep copies of your files, so a player in Mumbai downloads from Mumbai instead of from Germany.

→ **Cloudflare Pages. Free. Genuinely free, not trial-free.** Push your code, it builds and deploys worldwide. Nothing to manage.

**The backend** (the game server) is the opposite: it holds live state, it must be one specific machine per match, and it can't be cached.

→ **Rented servers.** Which brings us to the biggest cost decision in the project.

### 10.2 Where to rent servers — and why not AWS

Recall from the glossary: **egress** is data leaving your server. Cloud providers charge per gigabyte.

At 10,000 players you'll send roughly **150 terabytes per month**. Here's what different companies charge:

| Provider | Price per GB out | Cost of 150 TB/month |
|---|---|---|
| AWS | ~$0.109 | **~$16,400** |
| Google Cloud | ~$0.12 | **~$18,000** |
| DigitalOcean | bundled, then $0.01 | ~$1,500 |
| **Hetzner** | ~20 TB free per server, then ~€1/TB | **~€150** |
| **OVH** | unmetered on most plans | **~€0** |

**That is a hundred-fold difference on your largest expense.** Same game, same players, same code.

This is why I recommend Hetzner or OVH over AWS. It isn't a small optimisation — building on AWS could make a successful game financially unviable, while the same game on Hetzner is comfortably profitable.

**Why is AWS so expensive?** Because their pricing assumes business software, where you send small amounts of data and buy flexibility, global regions, and dozens of managed services. Games send enormous amounts of data and need very few of those services. You're paying for a toolbox you won't open.

**Decide this early.** Right now it's a config choice. After you've built on ten AWS-specific managed services, it's a migration project.

### 10.3 Making the connection secure

Browsers require encrypted WebSocket connections (`wss://`) from any site served over HTTPS. So each game server needs a TLS certificate.

Use **Caddy** — a web server that obtains and renews free Let's Encrypt certificates automatically, with about three lines of configuration. Give each game machine a subdomain (`eu1.basewar.io`, `eu2.basewar.io`) and Caddy handles the rest, forever.

### 10.4 Monitoring — do not skip this

Once real people are playing, you need to know when something is wrong *before* they tell you.

**On the server** (using `prom-client` → Prometheus → Grafana Cloud, all free at your size):

| Measurement | Why |
|---|---|
| Tick duration (50th, 95th, 99th percentile) | **The single most important number.** If it approaches 50ms, matches are slowing down. |
| Active rooms and connected players | Capacity and growth |
| Bytes sent per second per room | Your bill, live |
| Commands rejected, by reason | Spikes mean either a bug or someone attacking you |
| Room errors | Should be zero |
| Memory and garbage-collection pauses | Leaks show up here first |

**On the client** (sampled, not from everyone):
ping, snapshot jitter, frames per second, match length, how the player was eliminated.

**Product analytics** — arguably more valuable than all of the above:
how many visitors try practice mode, how many then play online, how many play a *second* match. That funnel tells you whether the game is actually fun. No server metric can tell you that.

Add **Sentry** (free tier) for automatic error reports from both client and server.

### 10.5 Security

Because the server is authoritative, most cheating is already impossible. And because the camera shows the whole map, there's no hidden information to steal — so map-hacks, the classic .io cheat, are meaningless here.

What remains:

| Threat | Defence |
|---|---|
| Fake gold, instant units, teleporting | Impossible by design — the client never writes state |
| Flooding the server with messages | Rate limit: ~20 commands/second per player; drop the rest, kick repeat offenders |
| Commanding another player's squads | Check `group.ownerId === session.seat` on every squad command |
| Griefing teammates via the donate mechanic | Verify same team, both alive, and rate limit it |
| Malformed messages crashing the server | Strict validation on every field; cap message size; never trust a client string |
| DDoS (flooding your server with junk traffic) | Cloudflare in front of the website and matchmaking. Game servers take direct connections, so rely on Hetzner's and OVH's built-in protection — both include it free |
| Scripted "perfect play" bots | Honestly: hard to solve, and not worth fighting at your scale. Rate limits catch the crude ones. Revisit only if it becomes a real problem |

### 10.6 Tasks

1. Deploy the client to Cloudflare Pages.
2. Provision one Hetzner server; Docker + Caddy; deploy the game server.
3. Set up Prometheus + Grafana dashboards and alerts.
4. Add Sentry to client and server.
5. Implement rate limiting and command validation hardening.
6. Write a one-command deploy script.
7. Test the whole thing end to end from a different network.

### 10.7 Done when

**You can send the URL to a stranger and they can play.** You get an alert if anything breaks. Deploying an update takes one command and kicks nobody.

---

## 11. PHASE 5 — Grow to 10,000

**Duration:** 2 weeks
**Goal:** the path from 100 to 10,000 players is "add more machines"

### 11.1 The two kinds of growth

**Vertical scaling** = get a bigger machine. Simple, no new problems. Works up to about 1,000 players.

**Horizontal scaling** = get more machines. Necessary beyond that, and introduces one new problem: when a player wants to join a match, *which machine* is it on?

### 11.2 How multiple servers work together

```
                Player clicks PLAY
                        │
                        ▼
              ┌───────────────────┐
              │   Matchmaker      │  small web service
              │                   │  "which server has room?"
              └─────────┬─────────┘
                        │ asks
                        ▼
              ┌───────────────────┐
              │      Redis        │  shared noticeboard:
              │                   │  every server posts its room list here
              └───────────────────┘
                        │
     answer: "join room 4821 on eu3.basewar.io, here's your ticket"
                        │
                        ▼
       Player connects DIRECTLY to eu3.basewar.io
```

**Redis** is a very fast in-memory database used here as a shared noticeboard. Each game server continuously posts "I'm running rooms 4821, 4822, 4823, with 3, 8, and 5 players." The matchmaker reads that noticeboard to answer join requests.

The key design property: **a match never moves between machines.** It's created on one server, lives there, and dies there. That means the servers don't have to coordinate about game state at all — which eliminates an entire category of horrible distributed-systems bugs.

Colyseus provides this via `@colyseus/redis-driver`. It's mostly configuration, not new code.

### 11.3 Using whole machines

Node.js runs JavaScript on **one CPU core per process**. An 8-core server running one process uses 12.5% of what you paid for.

The fix: run 8 processes on that machine, each handling its own set of rooms. They don't need to talk to each other — Redis already handles discovery. Each posts its own room list, and the matchmaker balances new matches across all of them.

### 11.4 Where to put servers

Latency tolerance is high here (Section 3.3), so you need far fewer locations than a shooter would. Two or three is plenty:

- **Europe** — Hetzner (Falkenstein / Helsinki), cheapest
- **US East** — Hetzner (Ashburn)
- **Asia-Pacific** — when demand appears

**A note relevant to you specifically:** you're in India. If your first players are Indian, they'd see ~150ms to Europe. Playable for this game, but not ideal. Hetzner has no Indian location, so you'd want OVH Mumbai or E2E Networks for an `ap-south` server. Worth deciding early because it slightly changes the hosting recommendation. (See Section 14.)

### 11.5 Persistence — accounts and leaderboards

Up to now nothing has been saved; a match ends and it's gone. That's fine, and deliberately so.

**Keep guest play as the default forever.** Every successful `.io` game does. A login wall before the first match destroys your funnel — most people who see one leave. Let people play immediately with just a nickname stored in their browser.

*Optional* accounts, added now, unlock persistent stats, all-time leaderboards, and cosmetics later. Use **Postgres** (Neon or Supabase, free at your size) — a traditional database that stores data permanently on disk.

### 11.6 Balance tuning — the real work of this phase

This is the least technical and most important part of Phase 5.

Your game is tuned against bots. Bots don't gang up on the leader, don't rage-quit, and don't exploit. Seven humans behave very differently.

**The specific risk I'd flag hardest.** In `constants.js`:

```js
export const CONQUEST_INCOME_BONUS = 2;   // permanent +gold/sec per kill
```

Destroy a rival base and you permanently earn +2 gold/second, forever, stacking with every kill.

Against bots this feels great — a reward for aggression. Against seven humans it's a **runaway leader problem**: whoever gets the first kill earns faster, so they get the second kill more easily, which makes them earn faster still. By minute 8 one player is unstoppable and the other seven are playing out a decided match. Players who experience that once often don't come back.

Three fixes, in order of preference:

1. **Diminishing returns** — the bonus shrinks with each kill (+2, +1.5, +1.1, …). Simplest, most predictable.
2. **Leader bounty** — killing the top player gives a bigger reward, so the lobby naturally turns on whoever is winning. This "everyone gangs up on first place" dynamic is one of the best things about free-for-all games. Lean into it.
3. **Catch-up income** — a small gold bonus for players far below the median level. Use carefully; if players can see it, it feels patronising.

**Make the tuning numbers server-configurable.** Right now every constant is compiled into the client. If they live in a server config file instead, you can retune balance in minutes based on real match data instead of shipping a new build. Given that balance is the most likely thing to go wrong, this is high-value.

**And budget for real playtesting.** Nothing in this document validates whether matches are fun. Eight real humans in a room, repeatedly, is the only way to find out — and it's both the highest-value testing in the project and the easiest to skip.

### 11.7 Tasks

1. Redis presence + Colyseus redis-driver.
2. Matchmaker service.
3. Multi-process per machine; multi-machine deployment.
4. Second region.
5. Postgres: optional accounts, persistent stats, all-time leaderboards.
6. Move balance constants into server config.
7. Structured playtest sessions; tune anti-snowball based on the data.
8. Load test to a verified 1,000 concurrent players.

### 11.8 Done when

1,000 concurrent players verified under load, and adding capacity for 10,000 is purely "rent more machines" — no new code.

---

# PART III — MONEY, THE FUTURE, AND YOUR DECISIONS

## 12. What this will cost

### 12.1 How to read these numbers

The estimates rest on assumptions to be replaced by Phase 3 measurements:

- 8 players per match → matches = players ÷ 8
- After the spatial grid fix: 20–40 matches per CPU core (deliberately conservative)
- ~15 KB/second downstream per player, ~0.5 KB/s upstream
- Monthly bandwidth assumes 30% average-to-peak (you don't hit peak all day)

> ## ✅ MEASURED — the estimates above are superseded
>
> **Phase 3 is complete and both numbers are now measured, not guessed.**
>
> ### Bandwidth
>
> | | Phase 1 (JSON) | **Phase 3 (binary)** | Estimate above |
> |---|---|---|---|
> | Per player | 141 KB/s | **6.5 KB/s** | 15 KB/s |
> | Per snapshot | 14.6 KB | **664 B** | ~1.5 KB |
> | At 10,000 CCU | ~1,100 TB/mo | **~52 TB/mo** | ~150 TB/mo |
>
> A **21× reduction**, and better than the original target. What did it:
> raw bytes instead of JSON key names; positions quantized to 12 bits per axis
> (0.68px — invisible on a map drawn zoomed out); dropping three things the
> client can derive for itself (base rotation, soldier facing, and the
> soldier→squad link, which squads already imply via their member lists); and
> keyframes every 2s so names, colours, base positions and maxHp aren't
> retransmitted ten times a second.
>
> ### CPU — the estimate was badly pessimistic
>
> | | Estimate above | **Measured** |
> |---|---|---|
> | Matches per core | 20–40 | **296** (at 60% load, late-game match state) |
> | Cores at 10,000 CCU | 32–64 | **~5** |
>
> After the spatial grid, the simulation examines **27× fewer candidates** per
> proximity query. A full late-game match costs 0.10 ms per tick against a
> 50 ms budget.
>
> ### What this changes in the cost model
>
> Both directions favour the plan, and the shape of the bill changes:
> **CPU is no longer the constraint — bandwidth still is, just far less of it.**
> The §12 tables below are now conservative; at 10,000 CCU the real figure is
> closer to a handful of cores and ~52 TB/month. The Hetzner-vs-AWS argument
> only gets stronger, since egress is an even larger share of a smaller bill.
>
> Reproduce:
> - `docker compose exec server npx tsx test/bandwidth.mjs`
> - `docker run --rm -v "$PWD":/app -w /app -e ROOMS=20 -e WARMUP_SEC=900 node:20-alpine node apps/loadtest/src/rooms.mjs`

| Players (CCU) | Matches | CPU cores | Bandwidth/month |
|---|---|---|---|
| 100 | 13 | under 1 | ~1.5 TB |
| 1,000 | 125 | 4–6 | ~15 TB |
| 10,000 | 1,250 | 32–64 | ~120–160 TB |

### 12.2 At 100 players (launch)

| Item | Cost/month |
|---|---|
| Frontend — Cloudflare Pages | $0 |
| 1 server — Hetzner CPX31 (4 cores, 8 GB) | €14 |
| Database — not needed yet | $0 |
| Monitoring — Grafana Cloud free tier | $0 |
| Domain name | ~$1 |
| **Total** | **≈ $17/month** |

You can genuinely launch this for less than a restaurant meal per month.

### 12.3 At 1,000 players

| Item | Cost/month |
|---|---|
| 3 servers — Hetzner CCX33 (8 dedicated cores each) | €190 |
| Redis | €15 |
| Postgres (Neon paid) | $20 |
| Monitoring | $0 |
| **Total** | **≈ $250/month** |

### 12.4 At 10,000 players

| Item | Cost/month |
|---|---|
| 5–8 dedicated servers (~64 cores total) | €600–900 |
| Bandwidth beyond included allowance | €50–150 |
| Redis cluster | €50 |
| Postgres | $70 |
| Monitoring + error tracking (paid tiers) | $100 |
| Matchmaker / load balancer nodes | €40 |
| **Total** | **≈ $1,000–1,500/month** |

**The same thing on AWS: roughly $18,000–25,000/month**, almost entirely bandwidth.

### 12.5 Is that sustainable?

10,000 concurrent players is a genuinely successful game — hundreds of thousands of people playing across a day. At normal `.io` advertising rates that traffic supports several times $1,500/month.

**Infrastructure is not your business risk.** Making a game people want to play twice is.

---

## 13. The future: player avatars

You mentioned wanting to add player avatars later. Here's what that means technically, since it directly touches Section 3.

### 13.1 First: what kind of avatar?

The answer changes everything, so it's worth being specific. Three very different possibilities:

**Option A — A decorative avatar.** A little commander figure that stands near your base, waves, shows your chosen skin. Doesn't affect gameplay.

→ **Cost: almost nothing.** It's a cosmetic entity in the snapshot. No prediction needed, because the player isn't steering it moment to moment. A day's work.

**Option B — A commander you move with WASD.** You drive a character around the map. Maybe it buffs nearby squads, or captures things faster, or you use it to scout.

→ **Cost: this is where you need client-side prediction.** Everything in Section 3.4 becomes relevant. Realistically 2–3 weeks on top of the existing plan.

**Option C — A commander that also fights.** Aims, shoots, dodges, like diep.io.

→ **Cost: prediction *plus* lag compensation.** Lag compensation means the server rewinds time — when you fire, the server reconstructs where everyone was on *your* screen 80ms ago, and judges the shot against that. Otherwise you'd have to lead every target. This is the full hard-mode multiplayer stack, 4–6 weeks, and it introduces the "I shot him but he didn't die" arguments that shooters spend years tuning.

### 13.2 The good news: this plan doesn't block any of them

The architecture chosen here is *forward-compatible* with all three, and that's partly deliberate.

Specifically: because the simulation is a **shared package** running on both server and client (Phase 0), adding prediction later means:

1. Add a second message channel for avatar movement, with numbered inputs (30/second instead of the 1–3/second command rate). Upstream bandwidth is tiny, so this costs nothing.
2. Run the avatar-movement code on the client too — **it's already shared code, so this is free.** This is the part that would otherwise be expensive: in a typical architecture you'd have to reimplement the movement logic a second time in a different place and keep two copies in sync forever. You won't have to.
3. Add the input buffer and the replay-on-mismatch loop. This is the genuinely new work.
4. Predict **only your own avatar**. Other players' avatars keep using interpolation (rendered 100ms in the past), exactly like soldiers do. This is standard and it's what every game does — you only ever predict the thing your own hand controls.

So the expensive foundation is already being built in Phase 0 for other reasons. Prediction becomes an addition rather than a rewrite.

### 13.3 Two things to decide before you build avatars

**First: does the camera change?** Right now it shows the whole map. If avatars mean players zoom in and follow their commander, then:

- *Good news:* interest management becomes possible (Section 9.5). You'd only send entities near each player's view, cutting bandwidth substantially.
- *Bad news:* you'd need fog of war, hidden-information security (a cheating client could reveal what it isn't meant to see — a problem you currently don't have at all), and the whole-map readability that makes your game legible at a glance would be lost.

That's a genuine design trade, not a technical one. Decide it as a game designer.

**Second: does the avatar affect combat outcomes?** If yes, you're in Option C and should budget accordingly. If it only affects economy or movement — buffs, scouting, faster capture — you stay in Option B and avoid lag compensation entirely. **Option B is a much better value-for-effort ratio,** and I'd steer you there unless the shooting is the whole point.

### 13.4 My recommendation on sequencing

Launch without avatars. Get real players, real retention data, real feedback. *Then* decide whether avatars are what your players actually want, informed by evidence rather than intuition.

If the answer is yes, prefer Option B, and budget 2–3 weeks. Nothing in this plan will need to be undone.

---

## 14. Decisions I need from you

These change the plan, so the earlier you answer the better.


**1. Confirm 8 players per match?**
I recommend yes. Every number in `constants.js` — map size, base ring radius, all the ranges — is tuned for 8 bases. Bigger arenas of 40–100 players would need a much larger map, complete rebalancing, fog of war, and interest management: roughly **6 extra weeks**. Ship 8, revisit later with real data.

**2. Which modes at launch?**
You have three (FFA, Team, Mining). Each one triples the balance-testing work. I recommend **launching with FFA only**, adding Team about two weeks later, Mining after that.

**3. Where are your first players?**
This is the one I most need answered. If they're mainly Indian, Hetzner has no India location and we'd add OVH Mumbai or E2E Networks. If the audience is global or Western, Hetzner EU + US is cheaper and simpler.

**4. Accounts at launch, or guests only?**
I recommend **guests only** — nickname in the browser, no signup. A login wall before the first match is the single most reliable way to lose new players. Accounts arrive in Phase 5 for persistent leaderboards.

**5. Chat or pings?**
I recommend pings (Section 8.5). Text chat at scale is a moderation and legal workstream, not a feature.

**6. How do you plan to make money?**
It barely changes the architecture, but rewarded video ads versus cosmetic purchases decides whether Phase 5 needs a payments integration and an inventory system.

---

## Appendix A — Week 1, concretely

If you started tomorrow, this is the first week:

| Day | Task |
|---|---|
| 1 | Set up pnpm workspace. Move the 13 browser-free files into `packages/sim`. Fix imports. |
| 1 | **Fix `uid()`** — per-simulation counter, numeric IDs, recycling. Write the test. |
| 2 | Write `Simulation.js` with `applyCommand` / `step` / `drainEvents` / `getStateForNetwork`. |
| 2 | Move `Group.selected` out of the entity into client-side selection state. |
| 3 | Convert all 12 direct-mutation sites into `applyCommand()` calls. |
| 3 | Switch to a fixed 50ms timestep. |
| 4 | Move the simulation into a Web Worker. Build the `Connection` abstraction. |
| 4 | Replace the silent `try/catch` with real logging. |
| 5 | Play it. Confirm it feels **identical** to today. Fix whatever doesn't. |

At the end of that week nothing looks different to a player — and every phase after it becomes straightforward.

---

## Appendix B — Where to learn more

- **Gabriel Gambetta, "Fast-Paced Multiplayer"** — a free four-part series with interactive demos, the clearest explanation of prediction and reconciliation anywhere. Read this before Phase 6.
- **Valve's "Source Multiplayer Networking"** — the classic write-up of lag compensation.
- **Colyseus documentation** — genuinely good; start with the "Getting Started" room example.
- **Glenn Fiedler, gafferongames.com** — deeper networking theory, if you want the fundamentals.
