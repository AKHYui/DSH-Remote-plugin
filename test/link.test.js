import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../src/config.js';
import { LinkState, applyCustomCa, createLink } from '../src/link.js';
import { createMemoryLogger } from '../src/log.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { FakeWebSocket, createFakeTimers, flush } from '../tools/fake-ctx.mjs';

const REPO_CA = new URL('../../certs/ca.crt', import.meta.url);

const clock = { t: 0 };

// --------------------------------------------------------------------------- //
// private-CA trust
// --------------------------------------------------------------------------- //

test('applyCustomCa does nothing when no CA is configured', () => {
  const log = createMemoryLogger();
  assert.equal(applyCustomCa({}, log), false);
  assert.equal(applyCustomCa({ tlsCaFile: '' }, log), false);
  assert.equal(log.entries.length, 0, 'no configuration means no log noise');
});

test('applyCustomCa reports an unreadable CA file', () => {
  const log = createMemoryLogger();
  const missing = join(tmpdir(), `dsh-absent-${process.pid}-${clock.t}.crt`);
  assert.equal(applyCustomCa({ tlsCaFile: missing }, log), false);
  assert.match(log.text(), /could not be read/);
});

test('applyCustomCa installs a real CA exactly once', (t) => {
  if (!existsSync(REPO_CA)) {
    t.skip('certs/ca.crt is not present in this checkout');
    return;
  }
  // A unique copy, so the module-level "already installed" set starts clean.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ca-'));
  const copy = join(dir, 'ca.crt');
  writeFileSync(copy, readFileSync(REPO_CA));

  const first = createMemoryLogger();
  assert.equal(applyCustomCa({ tlsCaFile: copy }, first), true);
  assert.match(first.text(), /trusting the certificate authority/);

  const second = createMemoryLogger();
  assert.equal(applyCustomCa({ tlsCaFile: copy }, second), true);
  assert.equal(second.entries.length, 0, 'a known CA is not merged twice');
});

test('a configured CA is installed before the socket is dialed', () => {
  if (!existsSync(REPO_CA)) return;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ca-dial-'));
  const copy = join(dir, 'ca.crt');
  writeFileSync(copy, readFileSync(REPO_CA));

  FakeWebSocket.reset();
  const log = createMemoryLogger();
  const link = createLink({
    config: {
      serverUrl: 'wss://relay.example.com/attach',
      connectorToken: 'tok',
      deviceId: 'dev-1',
      deviceName: 'dev-1',
      autoConnect: true,
      reconnect: true,
      reconnectOnReplaced: false,
      heartbeatMs: 30_000,
      approvalTimeoutMs: 90_000,
      allowedSessions: [],
      allowInsecure: false,
      tlsCaFile: copy,
      logLevel: 'info',
    },
    log,
    WebSocketImpl: FakeWebSocket,
    timers: createFakeTimers(),
    now: () => 0,
  });
  link.start();
  assert.equal(FakeWebSocket.instances.length, 1, 'the dial happened');
  assert.match(log.text(), /trusting the certificate authority/);
});

function makeLink({ config = {}, WebSocketImpl = FakeWebSocket, timers = createFakeTimers() } = {}) {
  FakeWebSocket.reset();
  clock.t = 0;
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
  const link = createLink({
    config: resolved,
    log,
    platform: 'test',
    harness: { version: '0.1.0' },
    WebSocketImpl,
    timers,
    now: () => clock.t,
  });
  return { link, log, timers };
}

async function dial(options) {
  const context = makeLink(options);
  context.link.start();
  const socket = FakeWebSocket.last;
  socket.accept();
  await flush();
  return { ...context, socket };
}

async function ready(options) {
  const context = await dial(options);
  context.socket.deliver({ t: 'welcome', v: PROTOCOL_VERSION, deviceId: 'dev-1', serverTime: 0 });
  await flush();
  return context;
}

test('start dials the relay with the token in the query string', () => {
  const { link } = makeLink();
  link.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.last.url, 'wss://relay.example.com/api/v1/attach?token=tok');
  assert.equal(link.state, LinkState.CONNECTING);
});

test('the hello frame is sent as soon as the socket opens', async () => {
  const { link, socket } = await dial();
  const hello = socket.lastFrame();
  assert.equal(hello.t, 'hello');
  assert.equal(hello.v, PROTOCOL_VERSION);
  assert.equal(hello.deviceId, 'dev-1');
  assert.equal(hello.platform, 'test');
  assert.deepEqual(hello.capabilities, ['ops', 'events', 'approvals']);
  assert.deepEqual(hello.harness, { version: '0.1.0' });
  assert.equal(link.state, LinkState.HANDSHAKING);
  assert.equal(link.ready, false);
});

test('welcome makes the link ready and clears the backoff', async () => {
  const { link, socket } = await ready();
  assert.equal(link.state, LinkState.READY);
  assert.equal(link.ready, true);
  const status = link.status();
  assert.equal(status.deviceId, 'dev-1');
  assert.equal(status.welcome.deviceId, 'dev-1');
});

test('frames after the handshake reach the frame listener', async () => {
  const { link, socket } = await ready();
  const seen = [];
  link.on('frame', (frame) => seen.push(frame));

  socket.deliver({ t: 'req', id: 'r1', op: 'session.list', args: {} });
  socket.deliver({ t: 'ping', id: 'p1' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].op, 'session.list');
});

test('a malformed frame is dropped without breaking the link', async () => {
  const { link, socket, log } = await ready();
  socket.deliverRaw('{not json');
  socket.deliver({ t: 'nonsense' });
  assert.equal(link.state, LinkState.READY);
  assert.match(log.text(), /malformed relay frame/);
  assert.match(log.text(), /unsupported frame type/);
});

test('the heartbeat sends pings while the link is quiet', async () => {
  const { link, socket, timers } = await ready();
  clock.t = 1_000;
  assert.equal(timers.runNext(), 30_000);
  const pings = socket.framesOfType('ping');
  assert.equal(pings.length, 1);
  assert.equal(typeof pings[0].id, 'string');
  assert.equal(link.state, LinkState.READY, 'a healthy heartbeat keeps the link up');
});

test('a silent relay forces a reconnect', async () => {
  const { link, timers } = await ready();
  // The relay never answers again; advance well past 2.5 heartbeats.
  clock.t = 500_000;
  assert.equal(timers.runNext(), 30_000);
  assert.equal(link.state, LinkState.IDLE);
  assert.equal(timers.pendingCount(), 1, 'a reconnect is scheduled');

  timers.runNext();
  assert.equal(FakeWebSocket.instances.length, 2, 'the second dial happens after the backoff');
});

test('close 4001 is terminal by default', async () => {
  const { link, socket, timers } = await ready();
  socket.serverClose(4001, 'replaced');
  assert.equal(link.state, LinkState.STOPPED);
  assert.match(link.terminalReason, /took over this device id/);
  assert.equal(timers.pendingCount(), 0);
});

test('close 4001 reconnects when explicitly allowed', async () => {
  const { link, socket, timers } = await ready({ config: { reconnectOnReplaced: true } });
  socket.serverClose(4001, 'replaced');
  assert.equal(link.state, LinkState.IDLE);
  assert.equal(timers.pendingCount(), 1);
});

test('a rejected token and a protocol mismatch are terminal', async () => {
  const unauthorized = await ready();
  unauthorized.socket.serverClose(4401, 'bad token');
  assert.equal(unauthorized.link.state, LinkState.STOPPED);
  assert.match(unauthorized.link.terminalReason, /connector token was rejected/);
  assert.equal(unauthorized.timers.pendingCount(), 0);

  const mismatch = await ready();
  mismatch.socket.serverClose(4400, 'version');
  assert.equal(mismatch.link.state, LinkState.STOPPED);
  assert.match(mismatch.link.terminalReason, /different protocol version/);
});

test('an ordinary drop reconnects with backoff', async () => {
  const { link, socket, timers } = await ready();
  socket.serverClose(1006, 'network');
  assert.equal(link.state, LinkState.IDLE);
  assert.equal(timers.pendingCount(), 1);

  const [delay] = timers.delays();
  assert.ok(delay >= 800 && delay <= 1_200, `expected a jittered first backoff, got ${delay}`);

  timers.runNext();
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('reconnect can be disabled', async () => {
  const { link, socket, timers } = await ready({ config: { reconnect: false } });
  socket.serverClose(1006, 'network');
  assert.equal(link.state, LinkState.IDLE);
  assert.equal(timers.pendingCount(), 0);
});

test('the down listener reports the close', async () => {
  const { link, socket } = await ready();
  const downs = [];
  link.on('down', (info) => downs.push(info));
  socket.serverClose(1006, 'gone');
  assert.equal(downs.length, 1);
  assert.equal(downs[0].code, 1006);
  assert.equal(downs[0].wasReady, true);
});

test('a bye frame sets a terminal reason', async () => {
  const { link, socket } = await ready();
  socket.deliver({ t: 'bye', code: 'heartbeat_timeout', message: 'no frame for 99s' });
  assert.match(link.terminalReason, /relay refused the session: heartbeat_timeout/);
});

test('send throws when the socket is not open and trySend reports it', async () => {
  const { link, socket } = await ready();
  link.stop();
  assert.throws(() => link.send({ t: 'pong', id: 'x' }), /not open/);
  assert.equal(link.trySend({ t: 'pong', id: 'x' }), false);
  assert.equal(socket.framesOfType('pong').length, 0);
});

test('stop closes the socket and is idempotent', async () => {
  const { link, socket } = await ready();
  link.stop('done');
  assert.equal(link.state, LinkState.STOPPED);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.closeCalls[0].code, 1000);
  link.stop('again');
  assert.equal(socket.closeCalls.length, 1);
});

test('a runtime without WebSocket reports a clear terminal reason', () => {
  // `null` (not `undefined`) is required: a default parameter would otherwise
  // reinstate the real global WebSocket.
  const { link, log } = makeLink({ WebSocketImpl: null });
  link.start();
  assert.equal(link.state, LinkState.STOPPED);
  assert.match(link.terminalReason, /no WebSocket implementation/);
  assert.equal(FakeWebSocket.instances.length, 0, 'nothing was dialed');
  assert.match(log.text(), /no WebSocket implementation/);
});

test('an invalid server URL is terminal, not a crash', () => {
  FakeWebSocket.reset();
  const log = createMemoryLogger();
  const link = createLink({
    config: {
      serverUrl: 'not a url',
      connectorToken: 'tok',
      deviceId: 'dev-1',
      deviceName: 'dev-1',
      autoConnect: true,
      reconnect: true,
      reconnectOnReplaced: false,
      heartbeatMs: 30_000,
      approvalTimeoutMs: 90_000,
      allowedSessions: [],
      allowInsecure: false,
      logLevel: 'info',
    },
    log,
    WebSocketImpl: FakeWebSocket,
    timers: createFakeTimers(),
    now: () => 0,
  });
  link.start();
  assert.equal(link.state, LinkState.STOPPED);
  assert.match(link.terminalReason, /invalid serverUrl/);
  assert.equal(FakeWebSocket.instances.length, 0, 'nothing was dialed');
});

test('the constructor throwing is handled as a retryable failure', async () => {
  class ExplodingWebSocket {
    constructor() {
      throw new Error('no route to host');
    }
  }
  const { link, timers, log } = makeLink({ WebSocketImpl: ExplodingWebSocket });
  link.start();
  assert.equal(link.state, LinkState.IDLE);
  assert.equal(timers.pendingCount(), 1);
  assert.match(log.text(), /could not open the socket: no route to host/);
});
