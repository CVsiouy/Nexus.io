import { Game } from './Game.js';
import { isTypingInto } from './dom.js';
import { initTutorial } from './tutorial.js';
import { readQuality, writeQuality } from './quality.js';
import { tutorialEnabled, setTutorialEnabled } from './firstRun.js';

let game = null;

/**
 * Collapsible HUD panels. Each `.collapsible` panel starts collapsed (a small
 * semi-transparent handle) and toggles open on click of its handle, or via an
 * optional keyboard hotkey declared in `data-hotkey` (e.g. "KeyB" for Buffs).
 */
function initCollapsiblePanels() {
  const panels = [...document.querySelectorAll('.collapsible')];

  /**
   * Open one panel in a group and the others in it close.
   *
   * The leaderboard and the map both live in the top-right corner and both
   * expand downward, so with two open at once they simply sat on top of each
   * other — and on a phone the open leaderboard covered the map's own button,
   * making it unreachable. Grouping them means the corner can only ever hold
   * one open panel, which removes the overlap by construction rather than by
   * finding offsets that happen not to collide.
   */
  const exclusive = (panel) => {
    const group = panel.dataset.exclusive;
    if (!group) return;
    for (const other of panels) {
      if (other !== panel && other.dataset.exclusive === group) {
        other.classList.add('collapsed');
      }
    }
  };

  const toggle = (panel) => {
    const opening = panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    if (opening) exclusive(panel);
  };

  for (const panel of panels) {
    const handle = panel.querySelector('.panel-handle');
    if (handle) {
      handle.addEventListener('click', (e) => {
        // Don't toggle when clicking an interactive control inside the handle
        // (none currently, but future-proof).
        toggle(panel);
        e.stopPropagation();
      });
    }
  }

  // Hotkeys — a key toggles the panel that declares it.
  window.addEventListener('keydown', (e) => {
    // MUST come first. These hotkeys are plain letters (H, B) and they call
    // preventDefault, so without this guard those characters simply cannot be
    // typed anywhere on the page — you could not put an "h" in your name.
    if (isTypingInto(e)) return;

    for (const panel of panels) {
      if (panel.dataset.hotkey && panel.dataset.hotkey === e.code) {
        toggle(panel);
        e.preventDefault();
        break;
      }
    }
  });
}

/**
 * Get as close to a native app as the browser allows. Called from the PLAY tap.
 *
 * Both calls below require a user gesture, and a PLAY tap is one. Neither can
 * be done at load time; attempting it just fills the console with
 * NotAllowedError and changes nothing.
 *
 * Both are wrapped because both legitimately reject, and neither is permitted
 * to stop a match from starting:
 *
 *   • requestFullscreen — iOS Safari implements the Fullscreen API for <video>
 *     only, so on an iPhone this always rejects and the browser bar stays put.
 *     The game has to be correct in that case regardless, which is why the
 *     canvas is still sized from the 100dvh on #app rather than from any
 *     assumption that we own the whole screen.
 *   • orientation.lock — requires fullscreen first on Android, and does not
 *     exist at all on iOS. Where it works the player never sees the landscape
 *     gate; where it does not, the gate is the fallback.
 *
 * Deliberately not awaited by the caller: a match should start the instant it
 * is asked to, not after a permission round-trip.
 */
async function goImmersive() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { /* iOS, or the player declined — play windowed */ }

  try {
    await screen.orientation?.lock?.('landscape');
  } catch { /* unsupported here — #rotate-gate is the fallback */ }
}

/**
 * The quality control in the menu. The preference itself lives in quality.js,
 * because Game needs it at construction time.
 */
/**
 * The in-game tutorial switch.
 *
 * Default ON: only an explicit "off" is stored, so a first-time visitor gets
 * the tutorial without having to find a setting first.
 */
function initTutorialToggle() {
  const box = document.getElementById('tutorial-toggle');
  if (!box) return;
  box.checked = tutorialEnabled();
  box.addEventListener('change', () => {
    setTutorialEnabled(box.checked);
    // Apply immediately: a player who switches it on mid-match expects it now,
    // not at the start of the next one.
    game?.rearmTutorial?.();
  });
}

function initQualityToggle(game) {
  const sel = document.getElementById('quality-select');
  if (!sel) return;
  sel.value = readQuality();
  sel.addEventListener('change', () => {
    writeQuality(sel.value);
    game?.applyQuality?.(sel.value);
  });
}

/**
 * Where the remembered player name lives.
 *
 * The key moved from `nexus.name` to `basewar.name` with the rename. A hard
 * switch would have silently wiped the saved name of every returning
 * playtester, so the old key is read once as a fallback and migrated across —
 * they never notice the rename happened.
 */
const NAME_KEY = 'basewar.name';
const LEGACY_NAME_KEY = 'nexus.name';

function readSavedName() {
  try {
    const current = localStorage.getItem(NAME_KEY);
    if (current) return current;

    const legacy = localStorage.getItem(LEGACY_NAME_KEY);
    if (legacy) {
      localStorage.setItem(NAME_KEY, legacy);
      localStorage.removeItem(LEGACY_NAME_KEY);
      return legacy;
    }
  } catch { /* private browsing — the player just retypes it */ }
  return null;
}
async function main() {
  game = new Game();
  await game.init();

  initCollapsiblePanels();
  initTutorial();
  initQualityToggle(game);
  initTutorialToggle();

  // Start a real match playing behind the menu straight away. It runs entirely
  // in this browser, so it costs the server nothing, and it shows a newcomer
  // what the game actually is far faster than any description.
  game.startAttract().catch(err => console.warn('[basewar] demo match unavailable:', err));

  // Show intro, wait for the player to pick a mode.
  const intro  = document.getElementById('intro');
  const status = document.getElementById('conn-status');

  const hideIntro = () => {
    intro.style.opacity    = '0';
    intro.style.transition = 'opacity 0.6s ease';
    setTimeout(() => { intro.style.display = 'none'; }, 600);
  };

  /** Practice: the whole game runs inside this browser. Costs the server nothing. */
  const practice = async (mode) => {
    // AWAITED, deliberately. requestFullscreen already fired synchronously inside
    // the tap, so the gesture is not lost — but fullscreen and the orientation
    // lock both change the viewport, and startMatch lays out the HUD from it.
    // Firing and forgetting meant the HUD was sized for the pre-fullscreen,
    // pre-rotation screen and its bottom row fell off the bottom of the phone.
    await goImmersive();
    hideIntro();
    game.startMatch(mode, { online: false });
  };

  /** Online: the game runs on the server; this browser just draws it. */
  const online = async (mode) => {
    await goImmersive();   // see practice() — the viewport must settle before layout
    const input = document.getElementById('player-name');
    const name  = (input?.value || '').trim() || 'Player';

    // Remember the name so returning players don't retype it. No account, no
    // login wall — a signup form before the first match is the surest way to
    // lose a new player.
    try { localStorage.setItem(NAME_KEY, name); } catch {}

    const btn = document.getElementById('start-online');
    if (btn) { btn.disabled = true; btn.textContent = '🌐 CONNECTING…'; }
    if (status) { status.textContent = 'Finding a match…'; status.classList.remove('err'); }

    // If the server can't be reached, say so here rather than dropping the
    // player into a world that will never update.
    game.onConnectionFailed = (detail) => {
      if (btn) { btn.disabled = false; btn.textContent = '🌐 PLAY ONLINE · FREE-FOR-ALL'; }
      if (status) {
        status.textContent = `Could not reach the server (${detail}). Is it running?`;
        status.classList.add('err');
      }
    };

    const ok = await game.startMatch(mode, { online: true, name });
    if (ok) hideIntro();
  };

  const savedName = readSavedName();
  const nameInput = document.getElementById('player-name');
  if (nameInput && savedName) nameInput.value = savedName;

  document.getElementById('start-online')?.addEventListener('click', () => online('ffa'));
  document.getElementById('start-ffa')?.addEventListener('click',    () => practice('ffa'));
  document.getElementById('start-team')?.addEventListener('click',   () => practice('team'));
  document.getElementById('start-mining')?.addEventListener('click', () => practice('mining'));

  // Enter in the name box starts an online match.
  nameInput?.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') online('ffa');
  });
}

main().catch(console.error);
