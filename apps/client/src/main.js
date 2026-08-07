import { Game } from './Game.js';
import { isTypingInto } from './dom.js';

let game = null;

/**
 * Collapsible HUD panels. Each `.collapsible` panel starts collapsed (a small
 * semi-transparent handle) and toggles open on click of its handle, or via an
 * optional keyboard hotkey declared in `data-hotkey` (e.g. "KeyB" for Buffs).
 */
function initCollapsiblePanels() {
  const panels = [...document.querySelectorAll('.collapsible')];

  for (const panel of panels) {
    const handle = panel.querySelector('.panel-handle');
    if (handle) {
      handle.addEventListener('click', (e) => {
        // Don't toggle when clicking an interactive control inside the handle
        // (none currently, but future-proof).
        panel.classList.toggle('collapsed');
        e.stopPropagation();
      });
    }
  }

  // Hotkeys — a key toggles the panel that declares it.
  window.addEventListener('keydown', (e) => {
    // MUST come first. These hotkeys are plain letters (H, Q, B) and they call
    // preventDefault, so without this guard those characters simply cannot be
    // typed anywhere on the page — you could not put an "h" in your name.
    if (isTypingInto(e)) return;

    for (const panel of panels) {
      if (panel.dataset.hotkey && panel.dataset.hotkey === e.code) {
        panel.classList.toggle('collapsed');
        e.preventDefault();
        break;
      }
    }
  });
}

async function main() {
  game = new Game();
  await game.init();

  initCollapsiblePanels();

  // Start a real match playing behind the menu straight away. It runs entirely
  // in this browser, so it costs the server nothing, and it shows a newcomer
  // what the game actually is far faster than any description.
  game.startAttract().catch(err => console.warn('[nexus] demo match unavailable:', err));

  // Show intro, wait for the player to pick a mode.
  const intro  = document.getElementById('intro');
  const status = document.getElementById('conn-status');

  const hideIntro = () => {
    intro.style.opacity    = '0';
    intro.style.transition = 'opacity 0.6s ease';
    setTimeout(() => { intro.style.display = 'none'; }, 600);
  };

  /** Practice: the whole game runs inside this browser. Costs the server nothing. */
  const practice = (mode) => {
    hideIntro();
    game.startMatch(mode, { online: false });
  };

  /** Online: the game runs on the server; this browser just draws it. */
  const online = async (mode) => {
    const input = document.getElementById('player-name');
    const name  = (input?.value || '').trim() || 'Player';

    // Remember the name so returning players don't retype it. No account, no
    // login wall — a signup form before the first match is the surest way to
    // lose a new player.
    try { localStorage.setItem('nexus.name', name); } catch {}

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

  const savedName = (() => { try { return localStorage.getItem('nexus.name'); } catch { return null; } })();
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
