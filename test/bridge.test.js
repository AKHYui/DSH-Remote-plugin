import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridge } from '../src/bridge.js';
import { resolveConfig } from '../src/config.js';
import { createMemoryLogger } from '../src/log.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { FakeWebSocket, createFakeCtx, createFakeTimers, flush } from '../tools/fake-ctx.mjs';

function makeBridge({ config = {}, ops = {}, streams = {}, ctx, timers = createFakeTimers() } = {}) {
  FakeWebSocket.reset();
  const resolved = resolveConfig(
    {
      serverUrl: 'wss://relay.example.com/api/v1/attach',
      connectorToken: 'tok',
      deviceId: 'dev-1',
      ...config,
    },
    {},
  ).config;
  const log = createMemoryLogger();
  const fake = ctx ?? createFakeCtx({ ops, streams });
  const bridge = createBridge({
    ctx: fake.ctx,
    config: resolved,
    log,
    platform: 'test',
    harness: { version: '0.1.0' },
    WebSocketImpl: FakeWebSocket,
    timers,
    now: () => 0,
  });
  return { bridge, fake, log, timers, config: resolved };
}

async function connected(options) {
  const context = makeBridge(options);
  context.bridge.start();
  const socket = FakeWebSocket.last;
  socket.accept();
  socket.deliver({ t: 'welcome', v: PROTOCOL_VERSION, deviceId: 'dev-1', serverTime: 0 });
  await flush();
  return { ...context, socket };
}

/** Wait until a frame satisfying the predicate appears. */
async function waitForFrame(socket, predicate, label = 'frame') {
  for (let i = 0; i < 60; i += 1) {
    const found = socket.sent.find(predicate);
    if (found) return found;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(socket.sent)}`);
}

test('start sends hello and reaches ready', async () => {
  const { bridge, socket } = await connected();
  assert.equal(bridge.link.ready, true);
  const hello = socket.sent[0];
  assert.equal(hello.t, 'hello');
  assert.equal(hello.deviceId, 'dev-1');
});

test('autoConnect: false loads the plugin without dialing', async () => {
  // The key was parsed, validated and echoed in `harness.info` for a long time while
  // nothing consulted it. Now it means what it says: no socket is opened at all.
  const { bridge, fake } = makeBridge({ config: { autoConnect: false } });
  bridge.start();
  await flush();

  assert.equal(FakeWebSocket.instances.length, 0, 'no socket may be opened');
  assert.equal(bridge.link.ready, false);
  // Loaded means ready to serve: the waterfalls are attached.
  assert.equal(fake.listenerCount('approval/request'), 1);
  assert.equal(fake.listenerCount('user-questions/request'), 1);
  assert.equal(bridge.status().link.state, 'idle', 'the link stays idle');
  assert.equal(bridge.status().link.attempts, 0, 'and never even attempts');

  bridge.stop('test');
});

test('a unary op is answered with res', async () => {
  const { socket } = await connected({
    ops: { 'session.list': () => ({ items: [{ sessionId: 's1' }] }) },
  });

  socket.deliver({ t: 'req', id: 'r1', op: 'session.list', args: { cursor: 'c' } });
  const response = await waitForFrame(socket, (frame) => frame.t === 'res' && frame.id === 'r1', 'res');

  assert.equal(response.ok, true);
  assert.deepEqual(response.value, { items: [{ sessionId: 's1' }] });
});

test('harness.info is served locally', async () => {
  const { socket } = await connected();
  socket.deliver({ t: 'req', id: 'r1', op: 'harness.info', args: {} });
  const response = await waitForFrame(socket, (frame) => frame.t === 'res' && frame.id === 'r1');
  assert.equal(response.ok, true);
  assert.equal(response.value.deviceId, 'dev-1');
  assert.equal(response.value.version, '0.1.0');
});

test('an op outside the allowlist is refused', async () => {
  const { socket } = await connected();
  socket.deliver({ t: 'req', id: 'r1', op: 'session.attachment', args: {} });
  const response = await waitForFrame(socket, (frame) => frame.t === 'res' && frame.id === 'r1');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'op_not_supported');
});

test('a gateway failure is reported as a failed res', async () => {
  const { socket } = await connected({
    ops: {
      'session.page': () => {
        const error = new Error('gone');
        error.code = 'session/not-found';
        throw error;
      },
    },
  });
  socket.deliver({ t: 'req', id: 'r1', op: 'session.page', args: {} });
  const response = await waitForFrame(socket, (frame) => frame.t === 'res' && frame.id === 'r1');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'remote_error');
  assert.match(response.error.message, /session\/not-found: gone/);
});

test('a streaming op produces open, chunk frames and end', async () => {
  const { socket } = await connected({
    streams: {
      'session.follow': async function* () {
        yield { seq: 1 };
        yield { seq: 2 };
      },
    },
  });

  socket.deliver({ t: 'req', id: 's1', op: 'session.follow', args: { address: { sessionId: 'x' } } });
  await waitForFrame(socket, (frame) => frame.phase === 'end', 'stream end');

  const frames = socket.framesFor('s1').filter((frame) => frame.t === 'stream');
  assert.deepEqual(
    frames.map((frame) => frame.phase),
    ['open', 'chunk', 'chunk', 'end'],
  );
  assert.deepEqual(frames[1].value, { seq: 1 });
  assert.deepEqual(frames[2].value, { seq: 2 });
});

test('a failing stream reports a stream error frame', async () => {
  const { socket } = await connected({
    streams: {
      'session.follow': async function* () {
        throw new Error('log unreadable');
      },
    },
  });
  socket.deliver({ t: 'req', id: 's1', op: 'session.follow', args: {} });
  const error = await waitForFrame(socket, (frame) => frame.phase === 'error', 'stream error');
  assert.equal(error.error.code, 'gateway_internal');
  assert.match(error.error.message, /log unreadable/);
});

test('cancel aborts an in-flight stream', async () => {
  const seen = { chunks: 0 };
  const { socket } = await connected({
    streams: {
      'session.follow': async function* (args, request) {
        for (let i = 0; i < 1000; i += 1) {
          if (request.signal?.aborted) return;
          seen.chunks += 1;
          yield i;
          await flush(1);
        }
      },
    },
  });

  socket.deliver({ t: 'req', id: 's1', op: 'session.follow', args: {} });
  await waitForFrame(socket, (frame) => frame.phase === 'chunk', 'first chunk');
  socket.deliver({ t: 'cancel', id: 's1' });
  await waitForFrame(socket, (frame) => frame.phase === 'end', 'stream end');

  const after = seen.chunks;
  await flush(5);
  assert.equal(seen.chunks, after, 'the generator stopped producing after cancel');
});

test('ping is answered with pong', async () => {
  const { socket } = await connected();
  socket.deliver({ t: 'ping', id: 'p-1' });
  const pong = await waitForFrame(socket, (frame) => frame.t === 'pong');
  assert.equal(pong.id, 'p-1');
});

test('cancel for an unknown request is ignored', async () => {
  const { socket, bridge } = await connected();
  socket.deliver({ t: 'cancel', id: 'ghost' });
  await flush();
  assert.equal(bridge.status().inflight, 0);
  assert.equal(socket.sent.length, 1, 'nothing was sent back');
});

test('a subscription forwards matching DSH events', async () => {
  const { socket, fake } = await connected();
  socket.deliver({ t: 'sub', id: 'relay:s1', topics: ['session.event'], args: {} });

  fake.emit('session/event', { id: 'sess-1' }, { type: 'assistant/message', seq: 4, time: 1, data: {} });
  const event = await waitForFrame(socket, (frame) => frame.t === 'evt');
  assert.equal(event.topic, 'session.event');
  assert.equal(event.payload.seq, 4);

  socket.deliver({ t: 'unsub', id: 'relay:s1' });
  fake.emit('session/event', { id: 'sess-1' }, { type: 'assistant/message', seq: 5, time: 2, data: {} });
  await flush(5);
  assert.equal(socket.framesOfType('evt').length, 1, 'unsub stops the fan-out');
});

test('a sessionIds filter is honoured', async () => {
  const { socket, fake } = await connected();
  socket.deliver({ t: 'sub', id: 'relay:s1', topics: ['session.event'], args: { sessionIds: ['wanted'] } });

  fake.emit('session/event', { id: 'ignored' }, { type: 'x', seq: 1, time: 1, data: {} });
  fake.emit('session/event', { id: 'wanted' }, { type: 'x', seq: 2, time: 2, data: {} });
  await flush(5);

  const events = socket.framesOfType('evt');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.sessionId, 'wanted');
});

test('the approval waterfall round-trips through the relay', async () => {
  const { socket, fake } = await connected();

  let nextCalled = false;
  const pending = fake.listener('approval/request')(
    { agent: { id: 'sess-1' }, toolName: 'pwsh', reason: 'run a command' },
    async () => {
      nextCalled = true;
      return 'unavailable';
    },
  );

  const ask = await waitForFrame(socket, (frame) => frame.topic === 'approval.ask', 'approval.ask');
  assert.equal(ask.payload.sessionId, 'sess-1');
  assert.equal(ask.payload.toolName, 'pwsh');

  socket.deliver({ t: 'approval', askId: ask.payload.askId, decision: 'approved' });
  assert.equal(await pending, 'allowed-once');
  // Both surfaces prompt, so the desktop is offered the request immediately;
  // the phone still wins because it is the one that actually answered.
  assert.equal(nextCalled, true);

  await waitForFrame(socket, (frame) => frame.topic === 'approval.settled', 'approval.settled');
});

test('the phone winning also withdraws the forwarded desktop prompt', async () => {
  // End-to-end wiring for the reported defect. DSH's own forwarder is what puts a
  // prompt on the desktop; when the phone answers first, that forwarded event has
  // to be finished or the window waits forever. The fake mirrors the host
  // gateway's bookkeeping (`@deepseek-ai/dsh-api-gateway/lib/index.js`).
  const ctx = createFakeCtx();
  const finished = [];
  const request = { agent: { id: 'sess-1' }, toolName: 'pwsh', callId: 'call-1' };
  const forwarded = {
    id: 'evt-1',
    source: { event: 'approval/request', request, context: { agentId: 'sess-1' } },
    frame: { type: 'waterfall', event: 'approval/request', eventId: 'evt-1', agentId: 'sess-1', request: { callId: 'call-1' } },
  };
  const table = new Map([[forwarded.id, forwarded]]);
  ctx.ctx.typertGateway.pendingRemoteEvents = table;
  ctx.ctx.typertGateway.finishRemoteEvent = (record) => {
    finished.push(record.id);
    table.delete(record.id);
  };

  const { socket, fake } = await connected({ ctx });
  const answer = fake.listener('approval/request')(request, async () => 'unavailable');
  const ask = await waitForFrame(socket, (frame) => frame.topic === 'approval.ask');

  socket.deliver({ t: 'approval', askId: ask.payload.askId, decision: 'approved' });
  assert.equal(await answer, 'allowed-once');
  await flush();

  assert.deepEqual(finished, ['evt-1'], 'the desktop prompt was finished exactly once');
  assert.equal(table.size, 0);
});

test('approvals defer to the desktop when the link is down', async () => {
  const { bridge, fake } = makeBridge();
  bridge.start();
  // Never finish the handshake: the link is not ready.
  const outcome = await fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'unavailable');
  assert.equal(outcome, 'unavailable');
});

test('losing the link cancels pending asks and clears subscriptions', async () => {
  const { socket, fake, bridge } = await connected();
  socket.deliver({ t: 'sub', id: 'relay:s1', topics: ['session.event'] });

  const pending = fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'delegated');
  await waitForFrame(socket, (frame) => frame.topic === 'approval.ask');

  socket.serverClose(1006, 'network');
  assert.equal(await pending, 'delegated');
  assert.equal(bridge.status().events.subscriptions, 0);
});

test('stop detaches listeners and disposes the bridge', async () => {
  const { socket, fake, bridge } = await connected();
  socket.deliver({ t: 'sub', id: 'relay:s1', topics: ['session.event'] });
  bridge.stop('test');

  assert.equal(bridge.link.state, 'stopped');
  assert.equal(fake.listenerCount('approval/request'), 0);
  assert.equal(fake.listenerCount('session/event'), 0);
  assert.equal(bridge.status().inflight, 0);
});

test('a slow unary op does not block later frames', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { socket } = await connected({
    ops: {
      'session.prompt': async () => {
        await gate;
        return { accepted: true };
      },
      'session.cancel': () => ({ accepted: true }),
    },
  });

  socket.deliver({ t: 'req', id: 'r1', op: 'session.prompt', args: {} });
  await flush();

  // A ping must be answered while the prompt is still in flight.
  socket.deliver({ t: 'ping', id: 'p-1' });
  const pong = await waitForFrame(socket, (frame) => frame.t === 'pong');
  assert.equal(pong.id, 'p-1');

  release();
  const response = await waitForFrame(socket, (frame) => frame.t === 'res' && frame.id === 'r1');
  assert.equal(response.ok, true);
});
