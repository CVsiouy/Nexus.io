import { Game } from './game/Game.js';

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
    // Ignore while typing in an input (none here, but safe).
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

  // Show intro, wait for user click
  const intro    = document.getElementById('intro');
  const startBtn = document.getElementById('start-btn');

  startBtn.addEventListener('click', () => {
    intro.style.opacity    = '0';
    intro.style.transition = 'opacity 0.6s ease';
    setTimeout(() => { intro.style.display = 'none'; }, 600);
    game.start();
  });
}

main().catch(console.error);
