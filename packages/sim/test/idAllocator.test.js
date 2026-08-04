import test from 'node:test';
import assert from 'node:assert/strict';
import { IdAllocator } from '../IdAllocator.js';

test('issues unique ids starting at 1', () => {
  const a = new IdAllocator();
  const ids = [a.alloc(), a.alloc(), a.alloc()];
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(new Set(ids).size, 3);
});

test('does not reuse a freed id immediately', () => {
  // A client one snapshot behind may still be applying updates addressed to a
  // just-deleted entity. Reusing its id straight away would misdirect them.
  const a = new IdAllocator({ reuseDelay: 4 });
  const first = a.alloc();
  a.free(first);
  const next = a.alloc();
  assert.notEqual(next, first, 'freed id was handed out again too soon');
});

test('does reuse ids once enough have queued up', () => {
  const a = new IdAllocator({ reuseDelay: 4 });
  const issued = [];
  for (let i = 0; i < 10; i++) issued.push(a.alloc());
  for (const id of issued) a.free(id);

  // 10 freed > reuseDelay of 4, so the oldest are now fair game.
  const recycled = a.alloc();
  assert.ok(issued.includes(recycled), 'expected an id to be recycled');
});

test('ids stay bounded under heavy churn — the reason this class exists', () => {
  // Simulate a long match: soldiers constantly spawning and dying. With the old
  // module-global counter this number climbed forever and would overflow a
  // 2-byte network field within minutes of server uptime.
  const a = new IdAllocator();
  const live = [];

  for (let i = 0; i < 200_000; i++) {
    live.push(a.alloc());
    if (live.length > 400) a.free(live.shift());   // steady state ~400 soldiers
  }

  assert.ok(
    a.highWater < 5000,
    `ids should stay small under churn, but reached ${a.highWater}`
  );
  assert.ok(a.highWater <= 65535, 'ids must fit in 2 bytes for the network protocol');
});

test('two simulations running side by side keep independent id spaces', () => {
  // The old counter was shared by every match in the process. Each allocator
  // must now be self-contained, so a match can be created, destroyed and
  // replayed without any reference to what else the server is doing.
  const roomA = new IdAllocator();
  const roomB = new IdAllocator();

  for (let i = 0; i < 1000; i++) roomA.alloc();
  assert.equal(roomB.alloc(), 1, 'room B should be unaffected by room A');
  assert.ok(roomA.highWater < 65535 && roomB.highWater < 65535);
});

test('liveCount tracks outstanding ids (leak detector)', () => {
  const a = new IdAllocator();
  const ids = [a.alloc(), a.alloc(), a.alloc()];
  assert.equal(a.liveCount, 3);
  a.free(ids[0]);
  assert.equal(a.liveCount, 2);
});
