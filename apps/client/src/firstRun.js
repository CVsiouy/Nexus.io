/**
 * firstRun.js — the in-match tutorial.
 * ────────────────────────────────────
 *
 * Three teaching surfaces exist and they do different jobs:
 *
 *   tutorial.js  Eight cards read BEFORE playing, from HOW TO PLAY. Ideas, not
 *                controls. Never opens by itself.
 *   firstRun.js  THIS. A short walkthrough during the match, naming each button
 *                in the order it becomes useful.
 *   tips.js      Afterwards. Fires each lesson the first time it is true for
 *                that player, in whatever order that happens.
 *
 * IT RENDERS WHERE MESSAGES RENDER, and while it is running **messages are
 * silenced entirely** (the gate is in Game.showNotice, so it covers contextual
 * tips and simulation notifications alike). Two things that look identical,
 * arriving in the same corner, read as one contradictory thing — and the
 * tutorial is the one that must win, because it is asking for an action.
 * Nothing is lost by holding the rest: tips are re-evaluated continuously, so
 * one still true when the tutorial ends simply fires then.
 *
 * ADVANCING. Steps that ask for an action clear themselves the moment the
 * player does it; explanation steps wait for Next. Prev always works. A step
 * already satisfied is never left sitting on screen — which is the failure of
 * a pure Next/Prev tutorial, where a player who acts ahead of the script is
 * told to do something they already did.
 *
 * EVERY CONDITION READS ONLY THE PLAYER'S OWN STATE. `world.groups` holds all
 * eight players' squads, so the checks go through `groupsOf(playerId)` — a
 * naive `status === 'attacking'` scan over every group would tick the attack
 * step over the instant any *bot* attacked anyone.
 *
 * Advisory only: nothing in this file sends a command.
 */

import { GARRISON_MAX } from '@basewar/sim';

const TOGGLE_KEY = 'basewar.tutorial';

/** The menu toggle. Default ON — only an explicit "off" is remembered. */
export function tutorialEnabled() {
  try { return localStorage.getItem(TOGGLE_KEY) !== 'off'; }
  catch { return true; }
}
export function setTutorialEnabled(on) {
  try { localStorage.setItem(TOGGLE_KEY, on ? 'on' : 'off'); } catch { /* private browsing */ }
}

/**
 * The script. Ordered so each button is named at the moment it first matters.
 *
 * `done` is optional: a step with one is an action, a step without is an
 * explanation that waits for Next. Bosses arrive long after this is over, so
 * the boss step tells rather than asks.
 */
const STEPS = [
  {
    text: 'Welcome. Tap <b>🏠 BASE</b> to centre the view on your mother base — use it any time you get lost.',
    done: (w) => w.focusedBase,
  },
  {
    text: 'This is your <b>mother base</b>. It mines gold on its own, and everything you build comes from here.',
  },
  {
    text: 'Tap <b>⛏ UPGRADE</b> first. It raises your gold per second permanently, and it pays for everything that follows.',
    done: (w) => w.mineLevel > w.mineLevel0,
  },
  {
    text: 'Now tap <b>🔺 SOLDIER</b>. Each one trains and waits inside your base, in the garrison.',
    done: (w) => w.queuedSoldiers > 0 || w.garrison > w.garrison0,
  },
  {
    text: `Keep going until the garrison reaches <b>${GARRISON_MAX}</b>. A squad cannot leave your base until it has reached ${GARRISON_MAX} — below that it is stuck at home to defend.`,
    done: (w) => w.garrison >= GARRISON_MAX || w.squads > 0,
  },
  {
    text: `Tap <b>🏰 RELEASE</b> to send all ${GARRISON_MAX} out as one squad. The button pulses green when the garrison is full.`,
    done: (w) => w.squads > 0,
  },
  {
    text: 'Tap <b>🧱 DEFENDER</b> to build walls around your base. Walls make you far harder to take, and they build alongside soldiers rather than blocking them.',
  },
  {
    text: 'To attack: <b>tap your squad to select it, then tap an enemy base</b>. It will march there and fight whatever it meets.',
    done: (w) => w.attacking,
  },
  {
    text: 'Last thing — a <b>boss</b> appears in the centre later on. Killing it grants permanent gold per second, but it takes three or four squads, not one. Good luck.',
  },
];


export class FirstRun {
  constructor() {
    this.el     = document.getElementById('firstrun');
    this.textEl = document.getElementById('fr-text');
    this.stepEl = document.getElementById('fr-step');
    this.prevEl = document.getElementById('fr-prev');
    this.nextEl = document.getElementById('fr-next');

    this.i = 0;
    this.active = false;
    this._base = null;      // opening values, so "did it go UP" is answerable
    this._holdAuto = false; // set by Back — see update()

    // Back parks the tutorial where the player put it. Without _holdAuto the
    // very next frame re-advanced past the step they had just gone back to,
    // because that step is complete and its `done` is still true — which is
    // exactly why Back looked broken.
    this.prevEl?.addEventListener('click', () => {
      if (this.i > 0) { this.i--; this._holdAuto = true; this._render(); }
    });
    // Next hands control back to the auto-advance, so a player who steps back
    // to re-read something is not stuck driving it by hand for the rest of it.
    this.nextEl?.addEventListener('click', () => { this._holdAuto = false; this._advance(); });
    document.getElementById('fr-skip')?.addEventListener('click', () => this.finish());
  }

  /**
   * Start of a match.
   *
   * MUST be called from startMatch(). The previous version wired this to
   * _requeue() — the Play Again path — so on a first visit it never ran at all
   * and the tutorial simply never appeared. That is the whole bug.
   */
  reset() {
    this.i = 0;
    this._base = null;
    this._holdAuto = false;
    this.active = !!this.el && tutorialEnabled();
    if (this.active) this._render();
    else this.el?.classList.remove('vis');
  }

  /** Finished or skipped — as far as memory goes they are the same. */
  finish() {
    this.active = false;
    this.el?.classList.remove('vis');
    // No persistent "done" flag: the menu toggle is the only switch, so leaving
    // a match and starting another shows it again while the toggle is on.
  }

  _advance() {
    this.i++;
    if (this.i >= STEPS.length) this.finish();
    else this._render();
  }

  /** Every frame, like Tips.update. Cheap, and mostly a no-op. */
  update(world, cam) {
    if (!this.active) return;
    if (this._holdAuto) return;   // the player pressed Back; leave them there

    const w = this._sample(world, cam);
    if (!w) return;                  // dead, or not ready — hold this step

    // A loop, not one step per frame: a player who already knows the game can
    // satisfy three steps before the box has finished appearing, and stepping
    // singly would walk them through a history of what they just did.
    let moved = false;
    while (this.i < STEPS.length) {
      const step = STEPS[this.i];
      if (!step.done) break;         // explanation — waits for Next
      let hit = false;
      try { hit = !!step.done(w); } catch { hit = false; }
      if (!hit) break;
      this.i++;
      moved = true;
    }

    if (this.i >= STEPS.length) { this.finish(); return; }
    if (moved) this._render();
  }

  _render() {
    if (!this.el) return;
    this.el.classList.add('vis');
    if (this.textEl) this.textEl.innerHTML = STEPS[this.i].text;
    if (this.stepEl) this.stepEl.textContent = `${this.i + 1}/${STEPS.length}`;
    if (this.prevEl) this.prevEl.disabled = this.i === 0;
    if (this.nextEl) this.nextEl.textContent = this.i === STEPS.length - 1 ? 'Done' : 'Next ›';
  }

  /**
   * Flatten the world to the handful of facts the steps ask about.
   *
   * Opening values are captured on the first sample so a step can ask "did this
   * go UP" rather than "is this non-zero" — every base now starts with a
   * garrison, so `garrison > 0` is true before the player has done anything.
   */
  _sample(world, cam) {
    const me = world?.players?.get(world.playerId);
    if (!me?.alive || !me.base) return null;
    const base = me.base;

    if (!this._base) {
      this._base = { mineLevel: base.mineLevel ?? 0, garrison: base.garrison ?? 0 };
    }

    let squads = 0;
    let attacking = false;
    for (const g of world.groupsOf(world.playerId)) {   // MINE only — see header
      if (g.memberIds.length === 0) continue;
      squads++;
      if (g.status === 'attacking') attacking = true;
    }

    let queuedSoldiers = 0;
    for (const e of base.soldierQueue ?? []) queuedSoldiers += e.count ?? 0;

    return {
      // focusBase() sets this; startMatch leaves the camera on 'free', so it
      // only becomes true once the player actually presses BASE (or Space).
      focusedBase: cam?.focusType === 'base',
      mineLevel:  base.mineLevel ?? 0,
      mineLevel0: this._base.mineLevel,
      garrison:   base.garrison ?? 0,
      garrison0:  this._base.garrison,
      queuedSoldiers,
      squads,
      attacking,
    };
  }
}
