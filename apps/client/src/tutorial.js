/**
 * tutorial.js — the "how to play" overlay.
 * ───────────────────────────────────────
 *
 * WHY A READER, NOT A SCRIPTED MISSION
 *
 * The obvious shape for a tutorial is a guided first match: do this, now do
 * that. It is also the wrong shape here. A match is a few minutes long and
 * everyone starts at once, so a mission that gates progress behind objectives
 * either desynchronises you from the other seven players or has to run in a
 * fake match nobody else is in — at which point it is teaching a game that is
 * not the one you are about to play.
 *
 * What a new player actually lacks is a handful of non-obvious *ideas*: that
 * waiting is a move, that attacking is irreversible, that standing between two
 * enemies is a choice you can decline. Those read in ninety seconds and take a
 * dozen matches to discover unaided.
 *
 * The cards below therefore explain the reasoning, not the buttons. Which
 * button does what is discoverable by pressing it; *when it is right to press*
 * is not. The in-match tips in tips.js then reinforce each idea at the moment
 * it first becomes true, which is where it sticks.
 */

const CARDS = [
  {
    title: 'Your mother base is the whole game',
    art: 'base',
    body: `
      <p>You have one base. Lose it and you are out; destroy everyone else's and
      you win. Everything else is in service of that.</p>
      <p>Your base earns <b>gold every second</b>, all by itself. Gold buys
      soldiers and walls. It also <b>heals</b> when it has not been hit for a
      while — so damage only really counts if the attacker finishes the job in
      one push.</p>
    `,
  },
  {
    title: 'Soldiers are queued, not placed',
    art: 'queue',
    body: `
      <p>Tap <b>Soldier</b> to add one to the build queue. They appear inside
      your base, not on the map — and they stay there until you release them.</p>
      <p>The number on the button is how many are queued. Tap the small
      <b>✕</b> to cancel the lot if you over-ordered.</p>
      <p><b>Population</b> caps how many you can have at once. It rises as your
      base levels up. When you hit the ceiling the build strip says so.</p>
    `,
  },
  {
    title: 'The garrison — waiting is a move',
    art: 'garrison',
    body: `
      <p>Soldiers waiting inside your base are in the <b>garrison</b>. They are
      safe there: nothing can touch them until you send them out.</p>
      <p><b>Release sends them out as a squad of 15 at once.</b> This is the
      single most important habit in the game.</p>
      <p>A lone soldier walking out is free food — one enemy squad kills it
      without slowing down, and you paid full price for nothing. Fifteen
      arriving together is a real force. <b>Being impatient here is the most
      common way new players lose.</b></p>
      <p class="tut-note">Watch the 🏰 number in the build strip. When it reads
      15/15, release.</p>
    `,
  },
  {
    title: 'Attacking is a commitment',
    art: 'attack',
    body: `
      <p>Tap an enemy and every selected squad locks on. <b>They will not stop
      until the target dies or they do.</b> You cannot call them back.</p>
      <p>So the decision deserves a moment. Ask: can what I am sending actually
      finish this? Half an army sent twice loses to an army sent once.</p>
      <p>Defending is the opposite — a defending squad can be redirected freely,
      which is part of why sitting still is stronger than it looks.</p>
    `,
  },
  {
    title: 'Walls, and why the ring matters',
    art: 'walls',
    body: `
      <p><b>Defender</b> builds a wall cell. Cells fill a ring around your base,
      up to three rings deep.</p>
      <p>A ring is only solid where it has cells. Enemies cannot walk through a
      wall — they must break it, or walk around to a gap. So a <b>complete</b>
      ring is worth far more than a partial one with the same number of cells.</p>
      <p>Only a few attackers can hit one wall cell at a time, so walls buy you
      something more valuable than damage: <b>time</b>.</p>
    `,
  },
  {
    title: 'Soldiers shield your base',
    art: 'shield',
    body: `
      <p>Soldiers standing in the ring around your base <b>shield it</b>. An
      attacker has to clear them before it can touch the base at all.</p>
      <p>This is why massing beats scattering. Fifteen soldiers together at home
      are much harder to get through than fifteen spread around the map.</p>
      <p>There is no hidden defence bonus — numbers, walls and position are the
      whole story, and all three are things you control.</p>
    `,
  },
  {
    title: 'Let your enemies fight each other',
    art: 'bait',
    highlight: true,
    body: `
      <p>Here is the trick most players never find.</p>
      <p>When <b>two different enemies</b> are converging on your base at the
      same time, standing your ground means fighting both at full strength — one
      after the other, with no time to recover.</p>
      <p>Instead, <b>move your soldiers away from the base</b> and wait.</p>
      <p>The two armies arrive, find each other, and fight. Your base takes some
      damage in the meantime — that is the price — but the survivor is left
      weak. Then you come back and take them.</p>
      <p class="tut-note">Only worth it when you would <em>lose</em> the straight
      fight, when the two enemies really are hostile to each other, and when
      your base is healthy enough to take the hits. Otherwise, stand and
      fight — a shielded base is very hard to crack.</p>
      <p>The bots know this one too. If a base you are attacking suddenly
      empties out, you may be the one being baited.</p>
    `,
  },
  {
    title: 'The centre: bosses and nodes',
    art: 'boss',
    body: `
      <p>A <b>boss</b> sits in the middle of the map behind its own wall, guarded
      by elite soldiers. It never attacks anyone — it just sits there.</p>
      <p>Killing one grants <b>permanent gold per second, for the rest of the
      match</b>. That compounds, so it is worth taking early. It also takes a
      real commitment: three or four squads, not one.</p>
      <p>In <b>Mining</b> mode, holding a node adds income too — but every squad
      parked on a node is a squad not fighting. That trade is the mode.</p>
    `,
  },
];

/** Tiny inline diagrams. Deliberately schematic — they label an idea, not a screenshot. */
function art(kind) {
  const c = {
    base:     '<circle cx="60" cy="34" r="15" fill="#16a34a"/><circle cx="60" cy="34" r="23" fill="none" stroke="#16a34a" stroke-opacity=".35" stroke-width="2"/>',
    queue:    '<rect x="30" y="20" width="26" height="28" rx="5" fill="#fff" stroke="#0077cc" stroke-width="2"/><circle cx="56" cy="20" r="8" fill="#e0392b"/><text x="56" y="24" font-size="10" fill="#fff" text-anchor="middle" font-weight="700">3</text><path d="M70 34h18" stroke="#94a3b8" stroke-width="2" stroke-dasharray="3 3"/>',
    garrison: '<circle cx="42" cy="34" r="16" fill="#16a34a"/><text x="42" y="39" font-size="12" fill="#fff" text-anchor="middle" font-weight="700">15</text><path d="M62 34h14" stroke="#16a34a" stroke-width="2"/><g fill="#16a34a">' + [0,1,2,3,4].map(i=>`<polygon points="${84+i*7},30 ${88+i*7},38 ${80+i*7},38"/>`).join('') + '</g>',
    attack:   '<g fill="#0077cc">' + [0,1,2].map(i=>`<polygon points="${26+i*9},30 ${30+i*9},38 ${22+i*9},38"/>`).join('') + '</g><path d="M58 34h22" stroke="#dc2626" stroke-width="2" marker-end="url(#tut-arrow)"/><circle cx="96" cy="34" r="12" fill="#dc2626"/>',
    walls:    '<circle cx="60" cy="34" r="12" fill="#16a34a"/>' + Array.from({length:10},(_,i)=>{const a=i/10*Math.PI*2;return `<rect x="${60+Math.cos(a)*26-3.5}" y="${34+Math.sin(a)*26-3.5}" width="7" height="7" rx="1.5" fill="${i===7?'#f8d3d3':'#3b82f6'}"/>`}).join(''),
    shield:   '<circle cx="60" cy="34" r="12" fill="#16a34a"/>' + Array.from({length:8},(_,i)=>{const a=i/8*Math.PI*2;return `<polygon points="${60+Math.cos(a)*24},${34+Math.sin(a)*24-4} ${64+Math.cos(a)*24},${34+Math.sin(a)*24+4} ${56+Math.cos(a)*24},${34+Math.sin(a)*24+4}" fill="#16a34a"/>`}).join(''),
    bait:     '<circle cx="60" cy="34" r="11" fill="#16a34a" fill-opacity=".45"/><g fill="#16a34a">' + [0,1,2].map(i=>`<polygon points="${18+i*8},48 ${22+i*8},56 ${14+i*8},56"/>`).join('') + '</g><path d="M46 40 22 50" stroke="#16a34a" stroke-width="2" stroke-dasharray="3 3"/><g fill="#dc2626">' + [0,1].map(i=>`<polygon points="${96+i*8},20 ${100+i*8},28 ${92+i*8},28"/>`).join('') + '</g><g fill="#7c3aed">' + [0,1].map(i=>`<polygon points="${96+i*8},46 ${100+i*8},54 ${92+i*8},54"/>`).join('') + '</g><path d="M100 32v10" stroke="#f59e0b" stroke-width="2.5"/>',
    boss:     '<polygon points="60,16 68,30 84,34 68,38 60,52 52,38 36,34 52,30" fill="#d4a017"/>' + Array.from({length:9},(_,i)=>{const a=i/9*Math.PI*2;return `<rect x="${60+Math.cos(a)*27-3}" y="${34+Math.sin(a)*27-3}" width="6" height="6" rx="1.5" fill="#8b7355"/>`}).join(''),
  }[kind] ?? '';
  return `<svg class="tut-art" viewBox="0 0 120 68" aria-hidden="true">
    <defs><marker id="tut-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0 0 L6 3 L0 6 z" fill="#dc2626"/></marker></defs>${c}</svg>`;
}

const SEEN_KEY = 'basewar.tutorialSeen';

export function initTutorial() {
  const root = document.getElementById('tutorial');
  if (!root) return;

  const body  = document.getElementById('tut-body');
  const dots  = document.getElementById('tut-dots');
  const nEl   = document.getElementById('tut-n');
  const total = document.getElementById('tut-total');
  const prev  = document.getElementById('tut-prev');
  const next  = document.getElementById('tut-next');

  let i = 0;
  if (total) total.textContent = String(CARDS.length);

  const render = () => {
    const c = CARDS[i];
    root.classList.toggle('highlight', !!c.highlight);
    body.innerHTML = `${art(c.art)}<h3 class="tut-title">${c.title}</h3>${c.body}`;
    if (nEl) nEl.textContent = String(i + 1);
    prev.disabled = i === 0;
    next.textContent = i === CARDS.length - 1 ? 'Got it' : 'Next →';
    dots.innerHTML = CARDS.map((_, k) =>
      `<span class="tut-dot${k === i ? ' on' : ''}" data-i="${k}"></span>`).join('');
    body.scrollTop = 0;
  };

  const open = () => { root.classList.add('vis'); i = 0; render(); };
  const close = () => {
    root.classList.remove('vis');
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private browsing */ }
  };

  next.addEventListener('click', () => { if (i < CARDS.length - 1) { i++; render(); } else close(); });
  prev.addEventListener('click', () => { if (i > 0) { i--; render(); } });
  dots.addEventListener('click', (e) => {
    const k = Number(e.target?.dataset?.i);
    if (Number.isInteger(k)) { i = k; render(); }
  });
  document.getElementById('tut-x')?.addEventListener('click', close);
  document.getElementById('open-tutorial')?.addEventListener('click', open);

  // Click the backdrop to dismiss, but not a click that started inside the card.
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  window.addEventListener('keydown', (e) => {
    if (!root.classList.contains('vis')) return;
    if (e.key === 'Escape')     { close(); e.stopPropagation(); }
    if (e.key === 'ArrowRight') next.click();
    if (e.key === 'ArrowLeft')  prev.click();
  }, true);   // capture: Escape must not also reach the game's pause handler

  // The tutorial never opens by itself.
  //
  // It used to open on a first visit, which is the conventional choice and was
  // wrong here: the menu already runs a live match behind it, so the first
  // thing a new player saw was a wall of text covering the one thing that
  // actually sells the game. Anyone who wants it can reach it from
  // 📖 HOW TO PLAY, which is on the menu and never moves.
  //
  // SEEN_KEY is still written on close. Nothing reads it today, but it is the
  // record of who has already been through the cards, and throwing that away
  // would make any future "offer this once" idea start from nothing.
}
