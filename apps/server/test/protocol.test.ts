import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, MAX_GROUPS_PER_COMMAND } from '@basewar/protocol';

/**
 * validateCommand is the front door: every one of these inputs could arrive
 * from a hostile browser. It only checks message SHAPE — whether the player can
 * afford it or owns that squad is the simulation's job — but a bad shape must
 * never get past this point.
 */

test('accepts every legitimate command', () => {
  const good: unknown[] = [
    { t: 'queue', unit: 'grunt', n: 1 },
    { t: 'queue', unit: 'sentinel', n: -1 },
    { t: 'turret', kind: 'missile' },
    { t: 'mine' },
    { t: 'release' },
    { t: 'balance' },
    { t: 'skill', stat: 'atk' },
    { t: 'spec', choice: 'bastion' },
    { t: 'move', g: [1, 2, 3], x: 100, y: 200 },
    { t: 'attack', g: [4], target: 99 },
    { t: 'defend', g: [7] },
    { t: 'defendNode', g: [7], node: 12 },
    { t: 'split', g: 5 },
    { t: 'merge', g: 5 },
    { t: 'donate', g: 5, to: 'p3' },
    { t: 'ping', x: 10, y: 20, kind: 'help' },
  ];
  for (const cmd of good) {
    assert.ok(validateCommand(cmd), `should have accepted ${JSON.stringify(cmd)}`);
  }
});

test('rejects junk that is not a command at all', () => {
  for (const bad of [null, undefined, 42, 'mine', [], true, () => {}, { }, { t: 123 }]) {
    assert.equal(validateCommand(bad), null, `should have rejected ${String(bad)}`);
  }
});

test('rejects unknown command types', () => {
  assert.equal(validateCommand({ t: 'giveMeGold' }), null);
  assert.equal(validateCommand({ t: '__proto__' }), null);
  assert.equal(validateCommand({ t: 'constructor' }), null);
});

test('rejects values outside the allowed set', () => {
  assert.equal(validateCommand({ t: 'queue', unit: 'dragon', n: 1 }), null);
  assert.equal(validateCommand({ t: 'queue', unit: 'grunt', n: 999 }), null, 'n must be exactly 1 or -1');
  assert.equal(validateCommand({ t: 'queue', unit: 'grunt', n: 0 }), null);
  assert.equal(validateCommand({ t: 'turret', kind: 'nuke' }), null);
  assert.equal(validateCommand({ t: 'skill', stat: 'luck' }), null);
  assert.equal(validateCommand({ t: 'spec', choice: 'godmode' }), null);
  assert.equal(validateCommand({ t: 'ping', x: 1, y: 1, kind: 'slur' }), null);
});

test('rejects path-traversal and injection attempts in string fields', () => {
  assert.equal(validateCommand({ t: 'queue', unit: '../../etc/passwd', n: 1 }), null);
  assert.equal(validateCommand({ t: 'queue', unit: '<script>alert(1)</script>', n: 1 }), null);
  assert.equal(validateCommand({ t: 'spec', choice: 'bastion; DROP TABLE' }), null);
});

test('rejects NaN and Infinity coordinates', () => {
  // These are the dangerous ones: they pass a naive typeof check, then poison
  // every position they touch and spread through the whole simulation.
  assert.equal(validateCommand({ t: 'move', g: [1], x: NaN, y: 0 }), null);
  assert.equal(validateCommand({ t: 'move', g: [1], x: Infinity, y: 0 }), null);
  assert.equal(validateCommand({ t: 'move', g: [1], x: 0, y: -Infinity }), null);
  assert.equal(validateCommand({ t: 'move', g: [1], x: '100' as any, y: 0 }), null);
});

test('rejects malformed squad id lists', () => {
  assert.equal(validateCommand({ t: 'move', g: [], x: 0, y: 0 }), null, 'empty list');
  assert.equal(validateCommand({ t: 'move', g: 'all' as any, x: 0, y: 0 }), null, 'not an array');
  assert.equal(validateCommand({ t: 'move', g: [1.5], x: 0, y: 0 }), null, 'non-integer id');
  assert.equal(validateCommand({ t: 'move', g: [-1], x: 0, y: 0 }), null, 'negative id');
  assert.equal(validateCommand({ t: 'move', g: [999999], x: 0, y: 0 }), null, 'id beyond 2 bytes');
  assert.equal(validateCommand({ t: 'move', g: [1, 'x' as any], x: 0, y: 0 }), null, 'mixed types');
});

test('caps how many squads one message may name', () => {
  // Without a cap, a single message could ask the server to do unbounded work.
  const fits = Array.from({ length: MAX_GROUPS_PER_COMMAND }, (_, i) => i + 1);
  assert.ok(validateCommand({ t: 'move', g: fits, x: 0, y: 0 }));

  const tooMany = Array.from({ length: MAX_GROUPS_PER_COMMAND + 1 }, (_, i) => i + 1);
  assert.equal(validateCommand({ t: 'move', g: tooMany, x: 0, y: 0 }), null);

  const absurd = Array.from({ length: 100_000 }, () => 1);
  assert.equal(validateCommand({ t: 'move', g: absurd, x: 0, y: 0 }), null);
});

test('caps the donate target name length', () => {
  assert.ok(validateCommand({ t: 'donate', g: 1, to: 'p3' }));
  assert.equal(validateCommand({ t: 'donate', g: 1, to: 'x'.repeat(5000) }), null);
});

test('strips unexpected extra fields rather than passing them through', () => {
  // Anything the client bolts on must not reach the simulation.
  const out = validateCommand({ t: 'mine', gold: 999999, isAdmin: true } as any);
  assert.deepEqual(out, { t: 'mine' });

  const move = validateCommand({ t: 'move', g: [1], x: 5, y: 6, speed: 9999 } as any);
  assert.deepEqual(move, { t: 'move', g: [1], x: 5, y: 6 });
});
