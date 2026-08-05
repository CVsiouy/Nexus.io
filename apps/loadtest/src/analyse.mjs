/**
 * Reads the match telemetry and answers the balance questions.
 *
 * Run after a playtest:
 *   docker compose exec server node ../loadtest/src/analyse.mjs
 *
 * The headline question, from MULTIPLAYER_PLAN.md §11.6: does
 * CONQUEST_INCOME_BONUS create a runaway leader? Each destroyed base grants +2
 * gold/second permanently, and it stacks — so the fear is that the first kill
 * compounds into an unrecoverable lead while seven people play out a decided
 * match.
 *
 * This does not ask anyone's opinion. It reads what happened.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.TELEMETRY_DIR || '/app/data';
const file = path.join(DIR, 'matches.jsonl');

if (!fs.existsSync(file)) {
  console.error(`\nNo telemetry at ${file} yet.\n\nPlay some matches first — every completed match appends one line.\n`);
  process.exit(1);
}

const matches = fs.readFileSync(file, 'utf8')
  .split('\n').filter(Boolean)
  .map((line, i) => { try { return JSON.parse(line); } catch { console.warn(`  (skipped malformed line ${i + 1})`); return null; } })
  .filter(Boolean);

if (!matches.length) { console.error('Telemetry file is empty.'); process.exit(1); }

const withHumans = matches.filter(m => m.humanCount > 0);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) + '%' : 'n/a');
const secs = (ms) => (ms / 1000).toFixed(0) + 's';
const mins = (ms) => (ms / 60000).toFixed(1) + 'm';

console.log(`\n═══ ${matches.length} matches recorded (${withHumans.length} with at least one human) ═══\n`);

// ── How do matches end? ──────────────────────────────────────────────────────
const byTimeout = matches.filter(m => m.reason === 'timeLimit').length;
const byElim = matches.length - byTimeout;

console.log('── How matches ended ──────────────────────────────────');
console.log(`  last base standing   ${byElim}  (${pct(byElim, matches.length)})`);
console.log(`  hit the 20m limit    ${byTimeout}  (${pct(byTimeout, matches.length)})`);
const avgLen = matches.reduce((a, m) => a + m.durationMs, 0) / matches.length;
console.log(`  average length       ${mins(avgLen)}`);
if (byTimeout / matches.length > 0.4) {
  console.log('  ⚠ Lots of timeouts — matches may be grinding. Consider making');
  console.log('    attacking cheaper or bases weaker.');
}

// ── The snowball question ────────────────────────────────────────────────────
console.log('\n── Runaway leader? (the CONQUEST_INCOME_BONUS worry) ──');

let firstBloodWins = 0, firstBloodMatches = 0;
for (const m of matches) {
  // Whoever made the earliest kill.
  const kills = m.players
    .filter(p => p.eliminatedAtMs !== null && p.eliminatedBy)
    .sort((a, b) => a.eliminatedAtMs - b.eliminatedAtMs);
  if (!kills.length) continue;

  const firstKiller = kills[0].eliminatedBy;
  const winner = m.players.find(p => p.alive) ??
                 [...m.players].sort((a, b) => b.xp - a.xp)[0];
  // eliminatedBy is an owner id; match it to the winner by seat name lookup.
  const killerSeat = m.players.find(p => `p${p.seat}` === firstKiller || p.name === firstKiller);
  if (!killerSeat) continue;

  firstBloodMatches++;
  if (winner && winner.seat === killerSeat.seat) firstBloodWins++;
}

if (firstBloodMatches) {
  const rate = firstBloodWins / firstBloodMatches;
  console.log(`  first kill → won the match   ${firstBloodWins}/${firstBloodMatches}  (${pct(firstBloodWins, firstBloodMatches)})`);
  console.log(`  (random chance would be ~13% with 8 players)`);
  if (rate > 0.55) {
    console.log('  ⚠ SNOWBALL CONFIRMED. Drawing first blood predicts winning far');
    console.log('    more than chance. Apply the fixes in MULTIPLAYER_PLAN.md §11.6:');
    console.log('    diminishing conquest income, or a bounty on the leader.');
  } else if (rate > 0.35) {
    console.log('  ~ First blood helps, but is not decisive. Probably healthy —');
    console.log('    aggression should be rewarded, just not guarantee a win.');
  } else {
    console.log('  ✓ No snowball evident.');
  }
} else {
  console.log('  (no kills recorded yet — play longer matches)');
}

// ── When does the gap become unrecoverable? ─────────────────────────────────
console.log('\n── Economy gap over time (leader vs median, XP) ───────');
const buckets = new Map();
for (const m of matches) {
  for (const s of m.samples ?? []) {
    const live = s.players.filter(p => p.alive);
    if (live.length < 2) continue;
    const xp = live.map(p => p.xp).sort((a, b) => a - b);
    const leader = xp[xp.length - 1];
    const median = xp[Math.floor(xp.length / 2)] || 1;
    const ratio = leader / Math.max(1, median);
    const minute = Math.floor(s.atMs / 60000);
    if (!buckets.has(minute)) buckets.set(minute, []);
    buckets.get(minute).push(ratio);
  }
}
const minutes = [...buckets.keys()].sort((a, b) => a - b);
for (const min of minutes) {
  const arr = buckets.get(min);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const bar = '█'.repeat(Math.min(40, Math.round(avg * 4)));
  console.log(`  min ${String(min).padStart(2)}   ${avg.toFixed(1)}x  ${bar}`);
}
const late = minutes.filter(m => m >= 8).flatMap(m => buckets.get(m));
if (late.length) {
  const lateAvg = late.reduce((a, b) => a + b, 0) / late.length;
  if (lateAvg > 3) {
    console.log(`  ⚠ By minute 8+ the leader averages ${lateAvg.toFixed(1)}x the median player's XP.`);
    console.log('    That is likely unrecoverable — the match is decided while most');
    console.log('    players are still playing it.');
  }
}

// ── How long are dead players just watching? ────────────────────────────────
console.log('\n── Time spent eliminated (spectating) ─────────────────');
const deadTimes = [];
for (const m of matches) {
  for (const p of m.players) {
    if (!p.wasHuman || p.eliminatedAtMs === null) continue;
    deadTimes.push(m.durationMs - p.eliminatedAtMs);
  }
}
if (deadTimes.length) {
  deadTimes.sort((a, b) => a - b);
  const median = deadTimes[Math.floor(deadTimes.length / 2)];
  const worst = deadTimes[deadTimes.length - 1];
  console.log(`  median  ${secs(median)}`);
  console.log(`  worst   ${secs(worst)}`);
  if (median > 5 * 60_000) {
    console.log('  ⚠ Eliminated players are watching for a long time. Spectating helps,');
    console.log('    but consider letting them requeue into a new match immediately.');
  }
} else {
  console.log('  (no human eliminations recorded)');
}

// ── Human results ───────────────────────────────────────────────────────────
if (withHumans.length) {
  console.log('\n── Humans vs bots ─────────────────────────────────────');
  let humanWins = 0, botWins = 0;
  for (const m of withHumans) {
    const winner = m.players.find(p => p.alive) ?? [...m.players].sort((a, b) => b.xp - a.xp)[0];
    if (!winner) continue;
    if (winner.wasHuman) humanWins++; else botWins++;
  }
  console.log(`  matches won by a human   ${humanWins}`);
  console.log(`  matches won by a bot     ${botWins}`);
  if (botWins > humanWins && withHumans.length >= 4) {
    console.log('  ⚠ Bots are beating humans. Either they are too strong, or the');
    console.log('    game is not teaching new players what to do.');
  }
}

// ── Player feedback ─────────────────────────────────────────────────────────
const fbFile = path.join(DIR, 'feedback.jsonl');
if (fs.existsSync(fbFile)) {
  const fb = fs.readFileSync(fbFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (fb.length) {
    console.log(`\n── Player feedback (${fb.length} responses) ────────────────────`);
    const avg = fb.reduce((a, f) => a + f.rating, 0) / fb.length;
    console.log(`  average rating   ${avg.toFixed(1)} / 5`);
    for (let r = 5; r >= 1; r--) {
      const n = fb.filter(f => f.rating === r).length;
      console.log(`    ${r}★  ${'▇'.repeat(n)} ${n || ''}`);
    }
    const comments = fb.filter(f => f.comment?.trim());
    if (comments.length) {
      console.log('\n  What they said:');
      for (const c of comments) {
        const tag = c.context?.won === true ? 'won ' : c.context?.won === false ? 'lost' : '    ';
        console.log(`    [${c.rating}★ ${tag}] ${c.comment.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
  }
}

console.log('');
