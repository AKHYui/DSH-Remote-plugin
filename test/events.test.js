import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvents } from '../src/events.js';
import { createMemoryLogger } from '../src/log.js';
import { createFakeCtx, flush } from '../tools/fake-ctx.mjs';

function makeEvents({ maxQueue } = {}) {
  const log = createMemoryLogger();
  const events = createEvents({ log, ...(maxQueue ? { maxQueue } : {}) });
  const sent = [];
  events.setSender(async (topic, payload) => {
    sent.push({ topic, payload });
  });
  return { events, sent, log };
}

test('an event is published only when a subscription wants it', async () => {
  const { events, sent } = makeEvents();
  events.publish('session.event', { sessionId: 's1', seq: 1 });
  await flush();
  assert.equal(sent.length, 0, 'nothing is forwarded without a subscription');

  events.subscribe('relay:s1', ['session.event']);
  events.publish('session.event', { sessionId: 's1', seq: 2 });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'session.event');
  assert.equal(sent[0].payload.seq, 2);
});

test('subscriptions are removed on unsubscribe and clear', async () => {
  const { events, sent } = makeEvents();
  events.subscribe('a', ['session.event']);
  events.subscribe('b', ['session.event']);
  events.unsubscribe('a');
  events.publish('session.event', { sessionId: 's1', seq: 1 });
  await flush();
  assert.equal(sent.length, 1, 'only the surviving subscription receives the event');

  events.clear();
  events.publish('session.event', { sessionId: 's1', seq: 2 });
  await flush();
  assert.equal(sent.length, 1);
});

test('unknown topics and empty topic lists are refused', () => {
  const { events, log } = makeEvents();
  assert.equal(events.subscribe('a', ['not.a.topic']), false);
  assert.equal(events.subscribe('b', []), false);
  assert.equal(events.subscribe('c', ['session.event']), true);
  assert.match(log.text(), /unknown topics/);
  assert.match(log.text(), /no topics/);
});

test('sessionIds narrows what a subscription receives', async () => {
  const { events, sent } = makeEvents();
  events.subscribe('relay:s1', ['session.event'], { sessionIds: ['wanted'] });

  events.publish('session.event', { sessionId: 'wanted', seq: 1 });
  events.publish('session.event', { sessionId: 'other', seq: 2 });
  await flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.sessionId, 'wanted');
});

test('a payload without a sessionId is forwarded rather than guessed at', async () => {
  const { events, sent } = makeEvents();
  events.subscribe('relay:s1', ['session.status'], { sessionIds: ['wanted'] });
  events.publish('session.status', { status: 'running' });
  await flush();
  assert.equal(sent.length, 1);
});

test('the queue drops instead of growing without bound', async () => {
  const { events } = makeEvents({ maxQueue: 2 });
  events.subscribe('relay:s1', ['session.event']);

  // A sender that never resolves keeps the queue from draining.
  events.setSender(() => new Promise(() => {}));
  for (let seq = 0; seq < 10; seq += 1) events.publish('session.event', { sessionId: 's1', seq });

  const stats = events.stats();
  // One event is already held by the in-flight drain, two fit in the queue,
  // and the remaining seven are dropped rather than buffered without bound.
  assert.equal(stats.queued, 2);
  assert.equal(stats.dropped, 7);
  assert.equal(stats.subscriptions, 1);
});

test('a failing sender drains the backlog without throwing', async () => {
  const { events, sent } = makeEvents();
  events.subscribe('relay:s1', ['session.event']);
  events.setSender(async () => {
    throw new Error('link is gone');
  });

  events.publish('session.event', { sessionId: 's1', seq: 1 });
  events.publish('session.event', { sessionId: 's1', seq: 2 });
  await flush();

  assert.equal(events.stats().queued, 0, 'the backlog is discarded, not retried forever');
  assert.equal(sent.length, 0);
});

test('attach binds the DSH event surface and maps payloads', async () => {
  const { events, sent } = makeEvents();
  const fake = createFakeCtx();
  const dispose = events.attach(fake.ctx);
  events.subscribe('relay:s1', ['session.event', 'session.status', 'session.activity']);

  assert.deepEqual(fake.eventNames().sort(), [
    'agent/status',
    'api-session/activity',
    'api-session/added',
    'api-session/removed',
    'session/event',
  ]);

  fake.emit('session/event', { id: 'sess-1' }, { type: 'assistant/message', seq: 9, time: 123, data: { turn: 1 }, surfaceOp: 'append' });
  fake.emit('agent/status', { agent: { id: 'sess-1' }, status: 'running' });
  fake.emit('api-session/added', { sessionId: 'sess-2', running: true, updatedAt: 5 });
  fake.emit('api-session/removed', 'sess-3');
  fake.emit('api-session/activity', 'sess-1', 77);
  await flush();

  assert.equal(sent.length, 5);
  assert.deepEqual(sent[0], {
    topic: 'session.event',
    payload: {
      sessionId: 'sess-1',
      seq: 9,
      type: 'assistant/message',
      time: 123,
      data: { turn: 1 },
      surfaceOp: 'append',
      sourceEventSeqs: null,
    },
  });
  assert.deepEqual(sent[1].payload, { sessionId: 'sess-1', status: 'running' });
  assert.deepEqual(sent[2].payload, { kind: 'added', sessionId: 'sess-2', running: true, updatedAt: 5 });
  assert.deepEqual(sent[3].payload, { kind: 'removed', sessionId: 'sess-3' });
  assert.deepEqual(sent[4].payload, { kind: 'activity', sessionId: 'sess-1', updatedAt: 77 });

  dispose();
  fake.emit('session/event', { id: 'sess-1' }, { type: 'x', seq: 10 });
  await flush();
  assert.equal(sent.length, 5, 'the disposer detaches every listener');
});

test('every event is bound exactly once, even with a root context', async () => {
  // Regression. The plugin used to bind on its own context *and* on `ctx.root`,
  // believing that only an ancestor's listener could see a scoped event. Cordis
  // keeps one global hook table, so both fired: every session event crossed the
  // wire twice. The old tests could not see it because the fake context had no
  // `root`; this one does, and it shares the registration path like the real host.
  const { events, sent } = makeEvents();
  const fake = createFakeCtx({ withRoot: true });
  events.attach(fake.ctx);
  events.subscribe('relay:s1', ['session.event']);

  assert.equal(fake.listenerCount('session/event'), 1, 'one binding, not one per context');

  fake.emit('session/event', { id: 'sess-1' }, { type: 'assistant/message', seq: 3, time: 1, data: {} });
  await flush();
  assert.equal(sent.length, 1, 'the phone must not receive the same event twice');
});

test('a throwing DSH handler cannot escape into the harness', async () => {
  const log = createMemoryLogger();
  const events = createEvents({ log });
  const sent = [];
  events.setSender(async (topic, payload) => sent.push({ topic, payload }));
  const fake = createFakeCtx();
  events.attach(fake.ctx);
  events.subscribe('relay:s1', ['session.event']);

  // A session object whose `id` getter throws must not break the emit path.
  const hostile = {
    get id() {
      throw new Error('boom');
    },
  };
  assert.doesNotThrow(() => fake.emit('session/event', hostile, { seq: 1 }));
  await flush();
  assert.match(log.text(), /session\/event handler failed/);
});
