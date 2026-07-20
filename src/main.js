import { Game } from './game/Game.js';

let game = null;

async function main() {
  game = new Game();
  await game.init();

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
