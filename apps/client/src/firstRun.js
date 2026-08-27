/**
 * firstRun.js — the first match teaches itself.
 * ─────────────────────────────────────────────
 *
 * There are now three teaching surfaces and they do different jobs. Worth
 * stating plainly, because the obvious instinct is to merge them:
 *
 *   tutorial.js  Eight cards, read BEFORE playing, reached from HOW TO PLAY.
 *                Explains ideas — why waiting is a move, why attacking is
 *                irreversible. Never opens by itself.
 *   firstRun.js  THIS. A short ordered walkthrough during match one only.
 *                Teaches the loop: build, gather, send, attack, defend.
 *   tips.js      From match two on. Fires each lesson the first time it is
 *                actually true for that player, in whatever order that happens.
 *
 * Handing over from this to tips.js is deliberate. A stepped walkthrough is
 * right exactly once — the second time it is in the way, because by then the
 * player knows the order and only wants the situational advice.
 *
 * THE ONE RULE THAT MATTERS: steps advance on the player DOING the thing, not
 * on tapping Next. A walkthrough that advances on Next teaches where the Next
 * button is. If the player never trains a soldier, step one stays up, because
 * the step has not been learned.
 *
 * Like tips.js, this is advisory only — nothing here sends a command.
 */

import { GARRISON_MAX } from '@basewar/sim';

const DONE_KEY = 'basewar.firstRunDone';

/**
 * Each step: what to say, and how to know the player has done it.
 *
 * `done` gets the same kind of cheap flattened snapshot tips.js uses. It runs
 * every frame, so nothing in here may walk the whole world.
 */
const STEPS = [
  {
    text: 'Tap <b>SOLDIER</b> to train your first unit. Soldiers cost gold, and gold accrues on its own.',
    done: (w) => w.queuedSoldiers > 0 || w.garrison > 0 || w.squads > 0,
  },
  {
    text: `New soldiers wait inside your base. Keep training until your garrison reaches <b>${GARRISON_MAX}</b>.`,
    done: (w) => w.garrison >= GARRISON_MAX || w.squads > 0,
  },
  {
    text: 'Now <b>drag from your base</b> to send them out together. Fifteen arriving at once beats fifteen arriving one at a time.',
    done: (w) => w.squads > 0,
  },
  {
    text: 'Tap an <b>enemy base</b> to attack it. Your squad will march there and fight whatever it meets.',
    done: (w) => w.attacking,
  },
  {
    text: 'Tap <b>DEFENDER</b> to ring your base with walls. A base behind walls is far harder to take.',
    done: (w) => w.hasWalls,
  },
];

function markDone() {
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private browsing */ }
}
function alreadyDone() {
  try { return localStorage.getItem(DONE_KEY) === '1'; }
  catch { return false; }   // private browsing: show it, which is the kinder failure
}

export class FirstRun {
  constructor() {
    this.el    = document.getElementById('firstrun');
    this.textEl = document.getElementById('fr-text');
    this.dotsEl = document.getElementById('fr-dots');
    this.i = 0;
    this.active = false;

    document.getElementById('fr-skip')?.addEventListener('click', () => this.finish());
  }

  /**
   * New match. Runs only if this player has never finished (or skipped) it.
   *
   * Checked per match rather than once at construction because the flag is set
   * mid-session — without this, skipping in match one would leave the box
   * primed to return in match two.
   */
  reset() {
    this.i = 0;
    this.active = !!this.el && !alreadyDone();
    if (this.active) this._render();
    else this.el?.classList.remove('vis');
  }

  /** Finished, or skipped — the two are the same as far as memory goes. */
  finish() {
    this.active = false;
    this.el?.classList.remove('vis');
    markDone();
  }

  /** Called every frame, like Tips.update. Cheap and mostly a no-op. */
  update(world) {
    if (!this.active) return;

    const w = this._sample(world);
    if (!w) return;                    // dead or not ready — hold the current step

    let advanced = false;
    // A loop, not a single check: a player who already knows the game can
    // satisfy three steps before the box has finished animating in, and
    // stepping one-per-frame would show them a walkthrough of the past.
    while (this.i < STEPS.length) {
      let hit = false;
      try { hit = !!STEPS[this.i].done(w); } catch { hit = false; }
      if (!hit) break;
      this.i++;
      advanced = true;
    }

    if (this.i >= STEPS.length) { this.finish(); return; }
    if (advanced) this._render();
  }

  _render() {
    if (!this.el) return;
    this.el.classList.add('vis');
    if (this.textEl) this.textEl.innerHTML = STEPS[this.i].text;
    if (this.dotsEl) {
      this.dotsEl.innerHTML = STEPS
        .map((_, k) => `<span class="fr-dot${k < this.i ? ' on' : ''}"></span>`)
        .join('');
    }
  }

  /**
   * Flatten the world to the few facts the steps ask about.
   *
   * Deliberately the same shape of helper as Tips._sample: one place that knows
   * WorldView, so a step's `done` reads plain values. The two ask different
   * questions, so they stay separate rather than one calling the other and
   * paying for facts it does not use.
   */
  _sample(world) {
    const me = world?.players?.get(world.playerId);
    if (!me?.alive) return null;
    const base = me.base;
    if (!base) return null;

    let squads = 0;
    let attacking = false;
    for (const g of world.groupsOf(world.playerId)) {
      if (g.memberIds.length === 0) continue;
      squads++;
      if (g.status === 'attacking') attacking = true;
    }

    let queuedSoldiers = 0;
    for (const e of base.soldierQueue ?? []) queuedSoldiers += e.count ?? 0;

    return {
      queuedSoldiers,
      garrison: base.garrison ?? 0,
      squads,
      attacking,
      // Counted as done the moment it is ORDERED, not when it finishes building
      // — the lesson is which button to press, and a wall takes real time.
      hasWalls: (base.walls?.length ?? 0) > 0 || (base.wallQueue?.length ?? 0) > 0,
    };
  }
}
