# BaseWar.io — Network Conquest

> **Grow your network. Sever their links. Destroy their base. Last network standing wins.**

A browser-based real-time strategy game built with **PixiJS + Vite**, containerized with **Docker**, requiring no backend or database.

---

## Table of Contents

1. [Game Overview](#game-overview)
2. [Game Mechanics](#game-mechanics)
3. [Controls](#controls)
4. [Entities and Definitions](#entities-and-definitions)
5. [Progression System](#progression-system)
6. [Architecture Overview](#architecture-overview)
7. [Codebase Structure](#codebase-structure)
8. [System Details](#system-details)
9. [Rendering Pipeline](#rendering-pipeline)
10. [World Generation](#world-generation)
11. [AI Bot System](#ai-bot-system)
12. [Tech Stack](#tech-stack)
13. [External APIs and Dependencies](#external-apis-and-dependencies)
14. [Backend and Database](#backend-and-database)
15. [Running Locally (Docker)](#running-locally-docker)
16. [Game Constants Reference](#game-constants-reference)
17. [Potential Game Names](#potential-game-names)

---

## Game Overview

BaseWar.io is a **single-player vs 10 AI bots** real-time strategy game set on a 6000x6000 world map.

Each player controls a **Base** (gear-shaped structure) and spawns **Soldiers** automatically over time. The goal is to expand a network of **Nodes** connected by **Links** across the map, while destroying enemy networks by severing their links.

### Core Win Condition
- Destroy all enemy bases (hp to 0)
- OR survive as the last player with a living network

### Core Lose Condition
- Your base reaches 0 HP

---

## Game Mechanics

### Network Graph
Every player maintains a directed graph of owned structures:

```
Base --link--> Node A --link--> Node B --link--> Node C
               |
               +--link--> Node D
```

- **Base** = root (always connected, never orphaned)
- **Nodes** = network expansion points (can be orphaned)
- **Links** = edges connecting nodes (have HP, can be cut)

### Orphan Mechanic (KEY MECHANIC)
If a **trunk link** (the single link connecting a node back to the base) is cut:
- All downstream nodes **immediately orphan**
- Orphaned nodes have a **12-second grace period** (shown as a countdown arc)
- If not reclaimed in time, nodes **revert to neutral**
- Player loses all soldiers stationed at orphaned nodes

This is the primary offensive strategy — identify and cut enemy trunk links.

### Combat
- Soldiers auto-attack enemies within their autoR (auto-range) radius
- Links and nodes have HP and can be attacked directly
- Links slowly **regenerate HP** (5s delay, then 2 HP/s)
- Nodes can be reinforced at Level 12+

### Node Claiming
1. Select a soldier (click or drag-select)
2. Click an **unclaimed node** within **link range** of your base or a claimed node
3. Soldier walks to the node and begins claiming (5 seconds)
4. Node becomes yours — a new link is auto-created

### Eatables (XP pickups)
Scattered shapes give XP when harvested:

| Shape    | Color  | XP | Rarity    |
|----------|--------|----|-----------|
| Square   | Yellow | 1  | Common    |
| Triangle | Purple | 4  | Uncommon  |
| Square   | Blue   | 12 | Rare      |
| Star     | Red    | 35 | Very Rare |

---

## Controls

| Input              | Action                        |
|--------------------|-------------------------------|
| Left-click soldier | Select single soldier         |
| Drag               | Box-select multiple soldiers  |
| Shift + click      | Add to selection              |
| Left-click node    | Send soldiers to claim it     |
| Left-click enemy   | Send soldiers to attack it    |
| Right-click        | Attack-move to position       |
| Left-click eatable | Send soldiers to harvest XP   |
| Scroll wheel       | Zoom in / out                 |
| WASD / Arrows      | Pan camera                    |
| Space              | Snap camera to your base      |

> **Tip:** Nodes can only be claimed if within link range (550px) of your base or an already-claimed node.
> **Tip:** You must SELECT a soldier first, THEN click the node — clicking a node with no soldiers selected does nothing.

---

## Entities and Definitions

### Base
```js
{
  id:             'player' | 'bot_N',
  ownerId:        string,
  position:       { x, y },
  hp:             number,        // starts at 1000
  maxHp:          number,
  linkRange:      550,           // how far links can extend
  linkSlots:      3,             // max outgoing links
  rotation:       number,        // gear rotation angle
  level:          number,        // 1-20
  spawnProtected: boolean,       // 20s grace on spawn
}
```

### GraphNode
```js
{
  id:               string,
  position:         { x, y },
  hp:               300,
  maxHp:            300,
  ownerId:          null | string,
  status:           'unclaimed' | 'neutral' | 'claimed' | 'orphaned',
  claimProgress:    0..1,
  claimerSoldierId: null | string,
  reinforced:       boolean,
  orphanedAt:       number,   // timestamp when orphaned
}
```

### Link
```js
{
  id:         string,
  fromId:     string,   // base.id or node.id
  toId:       string,   // node.id
  ownerId:    string,
  hp:         120,
  maxHp:      120,
  regenDelay: number,   // timestamp after which HP regenerates
}
```

### Soldier Types
| Type      | HP | Damage | Speed | Auto-Range | Unlock |
|-----------|----|--------|-------|------------|--------|
| Grunt     | 20 | 4      | 80    | 130        | Lv 1   |
| Harvester | 15 | 2      | 110   | 90         | Lv 3   |
| Sentinel  | 35 | 5      | 55    | 200        | Lv 8   |
| Saboteur  | 15 | 3      | 110   | 90         | Lv 8   |
| Vanguard  | 50 | 9      | 80    | 160        | Lv 20  |

---

## Progression System

| Level | XP    | Unlock / Bonus                      |
|-------|-------|-------------------------------------|
| 1     | 0     | Grunt soldiers                      |
| 2     | 50    | —                                   |
| 3     | 150   | Harvester unit                      |
| 4     | 300   | —                                   |
| 5     | 500   | +1 link slot (4), link range 500    |
| 8     | 1800  | Sentinel + Saboteur; +25% auto-atk  |
| 12    | 7000  | Node Reinforce ability              |
| 15    | 17000 | Specialization unlock; +1 slot (5)  |
| 20    | 52000 | Vanguard; +30% base HP              |

### Specializations (Level 15)
Choose one permanent specialization:
- **Sprawl** — +1 link slot, 40% faster claiming
- **Bastion** — +40% node HP, +30% base HP, links regen 40% faster
- **Warmonger** — +25% damage, +30% attack speed, 30% faster soldier spawn

---

## Architecture Overview

```
Browser
  |
  +-- index.html (CSS HUD light theme)  <--- HUDRenderer.js (DOM updates)
  |
  +-- main.js  -->  Game.js (main loop 60fps)
                        |
                    GameState (shared mutable state)
                        |
            +-----------+-----------+
            |                       |
        Systems                 Renderer
    (mutate state each tick)    (reads state)
            |                       |
    ConnectivitySystem         GameRenderer.js (PixiJS)
    CombatSystem               HUDRenderer.js  (DOM)
    ProductionSystem
    ProgressionSystem
    AISystem
    InputSystem
```

This is a **pure client-side Entity-Component-like architecture**:
- No server — all logic runs in the browser
- No real-time multiplayer — 10 AI bots simulate opponents
- Single shared state object flows through all systems each frame

---

## Codebase Structure

```
BaseWar.io/
├── Dockerfile               # Node 20 + Vite dev server
├── docker-compose.yml       # Single service: nodus (port 5173)
├── package.json             # Vite + PixiJS dependencies
├── vite.config.js           # Vite config (host 0.0.0.0 for Docker)
├── index.html               # HTML shell + CSS HUD (diep.io light theme)
│
└── src/
    ├── main.js              # Entry point — creates Game, hooks start button
    │
    ├── utils/
    │   ├── helpers.js       # uid(), dist2(), dist(), randRange(), etc.
    │   └── PoissonDisc.js   # Poisson-disc sampling for world gen
    │
    └── game/
        ├── constants.js     # All tuning values (HP, ranges, timings)
        ├── entities.js      # Class defs: Base, GraphNode, Link, Soldier, Eatable
        ├── GameState.js     # Mutable game state + notify/event queues
        ├── World.js         # World generation: node sites, bases, eatables
        ├── Game.js          # Main game loop, PixiJS init, resize handler
        │
        ├── systems/
        │   ├── ConnectivitySystem.js   # BFS orphan detection
        │   ├── CombatSystem.js         # HP, auto-attacks, regen
        │   ├── ProductionSystem.js     # Spawn, move, claim, harvest
        │   ├── InputSystem.js          # Mouse/keyboard -> orders
        │   ├── AISystem.js             # Bot AI (3 tiers)
        │   └── ProgressionSystem.js    # XP, levels, specialization, boss
        │
        └── renderer/
            ├── GameRenderer.js   # PixiJS world rendering
            └── HUDRenderer.js    # DOM-based HUD (bars, leaderboard, minimap)
```

---

## System Details

### ConnectivitySystem.js
Runs a **BFS** from each player's base every frame:
- Marks all reachable nodes as 'claimed'
- Unreachable nodes become 'orphaned' and start 12s countdown
- Complexity: O(V + E) per player per frame

### CombatSystem.js
Each tick:
1. Every living soldier scans enemies in autoR radius and attacks the nearest
2. Structures (nodes, links, bases) receive damage
3. After LINK_REGEN_DELAY ms since last hit, links regenerate at 2 HP/s
4. Dead entities are marked for removal

### ProductionSystem.js
- **Soldier spawn**: one per 4000ms near base
- **Movement**: soldiers steer toward their order target
- **Claiming**: 5-second channel when soldier reaches node
- **Harvesting**: soldier reaches eatable, collects XP for player
- **Eatable respawn**: every 2500ms if count < 250

### InputSystem.js
Converts events to **order objects** on soldiers:
```js
order = { kind: 'idle'|'move'|'attack'|'attackMove'|'claim'|'harvest',
          targetId: null | entity.id,
          position: null | {x, y} }
```
Click priority order: friendly soldier > enemy soldier > base > enemy node > enemy link > unclaimed node > empty space

### AISystem.js
Three bot tiers (passive / standard / aggressive) cycling through phases:
- **expand**: claim unclaimed nodes within link range
- **harvest**: send idle soldiers to collect eatables
- **attack**: find nearest enemy trunk link and sever it
- **defend**: reclaim orphaned owned nodes

### ProgressionSystem.js
- XP accumulates in player.pendingXP
- Checked against LEVELS table each tick
- Level-up applies bonuses and triggers unlocks
- Level 15 shows specialization modal
- Boss spawns at world center every 15 minutes

---

## Rendering Pipeline

PixiJS v7 with 10 separate Graphics layers in draw order:

| Layer | Name     | Content                              |
|-------|----------|--------------------------------------|
| 0     | _bg      | Static grid background (drawn once)  |
| 1     | _range   | Player link-range indicator rings    |
| 2     | _sites   | Unclaimed / orphaned node dots       |
| 3     | _links   | Player's own links ONLY              |
| 4     | _nodes   | Claimed nodes (circle + border)      |
| 5     | _bases   | Gear bases with HP arc               |
| 6     | _eat     | Eatable shapes                       |
| 7     | _boss    | Boss entity                          |
| 8     | _units   | Soldiers (triangle + HP bar)         |
| 9     | _fx      | Claim arcs, orphan timers, selection |
| 10    | _box     | Box-select rectangle (screen space)  |

**Visual design choices:**
- Light gray background (#f4f4f4) with grid lines (#d8d8d8) — diep.io style
- ONLY player's own links rendered — enemy links hidden to reduce clutter
- Bold outlines on all shapes (darken color by 50%)
- Camera: worldContainer position + scale updated each frame

HUDRenderer.js updates DOM elements (no PixiJS):
- Level, XP, HP bars
- Leaderboard sorted by node count
- Minimap on 150x150 canvas
- Notification toasts (fade after 4200ms)

---

## World Generation

### Node Sites — Poisson-Disc Sampling
`PoissonDisc.js` implements Bridson's algorithm:
- Even coverage across 6000x6000 map
- Minimum 120px spacing between nodes
- Produces ~2000-2500 node sites

### Guaranteed Local Nodes
After each base is placed, `_ensureLocalNodes()` guarantees **8 node sites** within 85% of LINK_RANGE (~467px):
- Ensures players can claim immediately without hunting the map
- Falls back gracefully if map is too dense to place more

### Base Placement
- Outer ring at 35-48% of world radius from center
- Minimum 750px separation between bases
- 300 placement attempts before random fallback

### Eatable Distribution
Weighted by distance to world center — rarer eatables near center, common ones at edges.

---

## AI Bot System

Bots think every 2000ms with a state machine:

```
EXPAND (claim nodes)
    |
    v (enough nodes)
HARVEST (collect XP)
    |
    v (enough soldiers)
ATTACK (sever enemy trunk links)
    |
    v (own nodes threatened)
DEFEND (reclaim orphaned nodes)
```

Tier thresholds:
| Phase trigger | Passive | Standard | Aggressive |
|---------------|---------|----------|------------|
| Switch to attack at | 5 nodes | 4 nodes | 3 nodes |

---

## Tech Stack

| Layer        | Technology   | Version  | Purpose                          |
|--------------|--------------|----------|----------------------------------|
| Runtime      | Node.js      | 20       | Development server runtime       |
| Bundler      | Vite         | ^5.0.0   | HMR dev server, ES module bundle |
| Renderer     | PixiJS       | ^7.4.2   | WebGL 2D rendering               |
| Language     | JavaScript   | ES2022   | Pure JS modules                  |
| Styling      | Vanilla CSS  | —        | HUD in index.html                |
| Fonts        | Google Fonts | CDN      | Rajdhani + Inter                 |
| Container    | Docker       | —        | Isolated Node 20 environment     |
| Orchestrator | Docker Compose | —      | Single service definition        |

---

## External APIs and Dependencies

### npm Dependencies
| Package   | Version  | Usage                      |
|-----------|----------|----------------------------|
| pixi.js   | ^7.4.2   | WebGL canvas rendering     |
| vite      | ^5.0.0   | Dev server + bundler       |

### CDN Resources
| Resource     | Domain                  | Usage                   |
|--------------|-------------------------|-------------------------|
| Google Fonts | fonts.googleapis.com    | Rajdhani + Inter fonts  |

### No external APIs used
- No analytics, telemetry, or tracking
- No game services (Nakama, Colyseus, etc.)
- No authentication APIs
- No payment or advertising APIs

---

## Backend and Database

**This game has no backend and no database.**

All game state lives in memory (GameState object) and is reset on page refresh.

```
Browser  --->  Vite Dev Server (static files only)
               No API routes
               No WebSocket server
               No database
               No user accounts
               No persistent state
```

### Potential future multiplayer architecture
If multiplayer were added:
```
Client (browser)
    |  WebSocket
    v
Colyseus.js / Socket.io (Node.js server)
    |
    +-- Redis      (ephemeral room state)
    +-- PostgreSQL (leaderboards, accounts)
```

---

## Running Locally (Docker)

### Prerequisites
- Docker Desktop installed and running

### Start the game
```bash
cd "BaseWar.io"

# First run (downloads Node 20 image, installs deps)
docker compose up --build

# Subsequent runs
docker compose up
```

Game available at: **http://localhost:5173**

### Stop
```bash
docker compose down
```

### docker-compose.yml
```yaml
services:
  nodus:
    build: .
    ports:
      - "5173:5173"
    volumes:
      - .:/app
      - /app/node_modules
```

### Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
```

---

## Game Constants Reference

All values in `src/game/constants.js`:

### World
| Constant      | Value | Description                   |
|---------------|-------|-------------------------------|
| WORLD_SIZE    | 6000  | Map dimensions in pixels      |
| MIN_NODE_DIST | 120   | Min spacing between node sites|

### Timing
| Constant         | Value   | Description                           |
|------------------|---------|---------------------------------------|
| SPAWN_INTERVAL   | 4000ms  | Time between soldier spawns           |
| CLAIM_TIME       | 5000ms  | Time to claim a node                  |
| ORPHAN_GRACE     | 12000ms | Grace period before orphaned revert   |
| LINK_REGEN_DELAY | 5000ms  | Delay before link HP regenerates      |
| BOSS_INTERVAL    | 15min   | Time between boss spawns              |
| SPAWN_PROTECT    | 20000ms | Spawn protection duration             |
| BOT_THINK_RATE   | 2000ms  | Bot strategy recalculation rate       |

### HP Values
| Constant         | Value  |
|------------------|--------|
| BASE_HP          | 1000   |
| NODE_HP          | 300    |
| LINK_HP          | 120    |
| BOSS_HP          | 5000   |
| LINK_REGEN_RATE  | 2 HP/s |

### Ranges
| Constant       | Value | Description                          |
|----------------|-------|--------------------------------------|
| LINK_RANGE     | 550   | Max distance for new links           |
| LINK_CAPACITY  | 3     | Max outgoing links per entity        |
| ATTACK_RANGE   | 32    | Soldier melee attack range           |
| CLAIM_RANGE    | 52    | Range at which claiming begins       |
| HARVEST_RANGE  | 42    | Range at which harvesting begins     |

### Camera
| Constant | Value |
|----------|-------|
| MIN_ZOOM | 0.15  |
| MAX_ZOOM | 2.5   |
| DEF_ZOOM | 1.1   |

---

## Potential Game Names

| Name        | Rationale                                          |
|-------------|----------------------------------------------------|
| **BaseWar.io** | War over mother bases — the actual game (CURRENT NAME) |
| ~~Nexus.io~~   | Nexus = network hub. Dropped: domain unavailable      |
| **Sevra.io**   | From "sever" — cutting links is the core move  |
| **Grida.io**   | Grid network, clean and punchy                 |
| **Plexo.io**   | Plexus = complex interconnected network        |
| **Lattis.io**  | Lattice = geometric node network               |
| **Trunca.io**  | Trunk link — the strategic target to sever     |
| **Linqr.io**   | Stylized "Linker"                              |
| **Nodara.io**  | Node + elegant suffix                          |
| **Splica.io**  | Splice / sever network topology                |
| **Spana.io**   | Span a network across the world                |
| **Vexia.io**   | Vex + network — aggressive and disruptive      |
| **Orbis.io**   | Latin for circle/network — elegant             |
| **Vextus.io**  | Vex + nexus — attacking the connection points  |
| **Arcana.io**  | Arc connections — abstract network feel        |
| **Knotix.io**  | Knot + matrix — tying and untying networks     |
| **Corda.io**   | Latin for cord/rope — the severable links      |
| **Retixa.io**  | Rete (Latin: net) + ix suffix                  |
| **Axona.io**   | Axon (nerve connection) — biological network   |

---

*Built with PixiJS + Vite + Docker. No servers. No databases. Pure browser network conquest.*
