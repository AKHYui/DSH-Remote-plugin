import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig } from '../src/config.js';
import { createMemoryLogger } from '../src/log.js';
import { OpError, createOps, targetedSessionId, wireArgs } from '../src/ops.js';
import { OP_TABLE, STREAM_OPS } from '../src/protocol.js';
import { createFakeCtx } from '../tools/fake-ctx.mjs';

function makeConfig(overrides = {}) {
  return resolveConfig(
    {
      serverUrl: 'wss://relay.example.com/attach',
      connectorToken: 't',
      deviceId: 'dev-1',
      ...overrides,
    },
    {},
  ).config;
}

function makeOps({ ops = {}, streams = {}, config = makeConfig(), harness = {} } = {}) {
  const fake = createFakeCtx({ ops, streams });
  const log = createMemoryLogger();
  return { ops: createOps({ gateway: fake.ctx.typertGateway, config, log, harness }), fake, log };
}

test('targetedSessionId understands both sessionId and address shapes', () => {
  assert.equal(targetedSessionId('session.prompt', { sessionId: 'a' }), 'a');
  assert.equal(targetedSessionId('session.page', { address: { kind: 'session', sessionId: 'b' } }), 'b');
  assert.equal(
    targetedSessionId('session.follow', { address: { kind: 'subagent', childSessionId: 'c' } }),
    'c',
  );
  assert.equal(targetedSessionId('session.list', {}), undefined);
});

test('harness.info is answered locally without touching the gateway', async () => {
  const { ops, fake } = makeOps({ harness: { version: '9.9.9' } });
  const info = await ops.run('harness.info');
  assert.equal(info.deviceId, 'dev-1');
  assert.equal(info.version, '9.9.9');
  assert.equal(info.gateway, true);
  assert.equal(fake.calls.length, 0);
});

test('session.list maps onto the session Remote and wraps the request', async () => {
  const { ops, fake } = makeOps({ ops: { 'session.list': () => ({ items: [] }) } });
  const value = await ops.run('session.list', { cursor: 'page-2' });
  assert.deepEqual(value, { items: [] });
  // Two calls: the forwarded list, then the one-frame archived-set lookup it
  // performs against the Workspace feed.
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].namespace, 'session');
  assert.equal(fake.calls[0].method, 'list');
  // `session.list` declares its parameter as `_request`, not `request`.
  assert.deepEqual(fake.calls[0].args, { _request: { cursor: 'page-2' } });
  assert.equal(fake.calls[1].namespace, 'workspace');
  assert.equal(fake.calls[1].method, 'follow');
});

test('wireArgs mirrors each Remote descriptor', () => {
  assert.deepEqual(wireArgs(OP_TABLE['session.list'], { a: 1 }), { _request: { a: 1 } });
  assert.deepEqual(wireArgs(OP_TABLE['session.page'], { a: 1 }), { request: { a: 1 } });
  assert.deepEqual(wireArgs(OP_TABLE['session.follow'], { a: 1 }), { request: { a: 1 } });
  assert.deepEqual(wireArgs(OP_TABLE['session.prompt'], { a: 1 }), { request: { a: 1 } });
  assert.deepEqual(wireArgs(OP_TABLE['model.catalog'], {}), {}, 'a method with no parameters gets none');
  assert.deepEqual(wireArgs(OP_TABLE['session.prompt'], undefined), { request: {} });
});

/**
 * Mirrors the real typert gateway, which validates argument keys against the
 * Remote's declared parameter name and rejects anything else.
 *
 * This is the check that caught the original bug: against the real DSH,
 * `session.list` failed with `missing "_request"` while every stubbed test passed.
 */
const REMOTE_DESCRIPTORS = {
  'session.list': ['_request'],
  'session.page': ['request'],
  'session.follow': ['request'],
  'session.prompt': ['request'],
  'session.cancel': ['request'],
  'session.create': ['request'],
  'session.selectModel': ['request'],
  'userQuestions.answer': ['agentId', 'callId', 'answer'],
  'fileUploads.upload': ['agentId', 'request'],
  'session.modelCatalog': [],
  // Archiving is a Workspace-registry operation, not a Session one — a Session
  // cannot archive itself. `archiveSession` also declares an optional
  // `stopActivity`, which is why a plain archive call declares only the request.
  'workspace.archiveSession': ['request'],
  'workspace.unarchiveSession': ['request'],
  // Not forwarded by the relay, but read by `session.list` to learn which
  // Sessions the desktop archived. It declares no parameters.
  'workspace.follow': [],
};

test('every forwarded op satisfies its real gateway argument descriptor', async () => {
  const seen = [];
  const checkDescriptor = (key, args) => {
    const declared = REMOTE_DESCRIPTORS[key];
    assert.ok(declared, `no descriptor known for ${key}`);
    assert.deepEqual(
      Object.keys(args ?? {}).sort(),
      [...declared].sort(),
      `${key} argument names must match the descriptor`,
    );
  };
  const gateway = {
    async invoke(request) {
      const key = `${request.namespace}.${request.method}`;
      seen.push(key);
      checkDescriptor(key, request.args);
      return { items: [] };
    },
    async stream(request) {
      const key = `${request.namespace}.${request.method}`;
      seen.push(key);
      checkDescriptor(key, request.args);
      return (async function* () {})();
    },
  };

  // Most ops take one request object; the multi-wire ones need their own shape
  // so the strict argument-name check stays meaningful for every op.
  const ARGS_BY_OP = {
    'userQuestions.answer': { agentId: 's', callId: 'c', answer: { answers: [] } },
    'fileUploads.upload': { agentId: 's', request: { data: 'AAAA', name: 'note.txt' } },
  };

  const ops = createOps({ gateway, config: makeConfig(), log: createMemoryLogger() });
  for (const op of Object.keys(OP_TABLE)) {
    const args = ARGS_BY_OP[op] ?? { sessionId: 's' };
    if (STREAM_OPS.has(op)) await ops.openStream(op, args);
    else await ops.run(op, args);
  }
  // One extra call: `session.list` opens `workspace.follow` to read the archived
  // set. The argument-name check above covers that call too, which is the point —
  // this is where an internal Remote read can silently disagree with the host.
  assert.equal(seen.length, Object.keys(OP_TABLE).length + 1);
  assert.equal(seen.filter((key) => key === 'workspace.follow').length, 1);
});

test('session.prompt reaches the exact Remote with the caller args', async () => {
  const { ops, fake } = makeOps({ ops: { 'session.prompt': (args) => ({ accepted: true, seen: args }) } });
  const value = await ops.run('session.prompt', { sessionId: 's1', content: [{ type: 'text', text: 'hi' }] });
  assert.equal(value.accepted, true);
  assert.equal(fake.calls[0].method, 'prompt');
});

test('an unknown op is refused without reaching the gateway', async () => {
  const { ops, fake } = makeOps();
  await assert.rejects(ops.run('session.deleteEverything', {}), (error) => {
    assert.ok(error instanceof OpError);
    assert.equal(error.code, 'op_not_supported');
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

test('a streaming op cannot be run as a unary op', async () => {
  const { ops } = makeOps();
  await assert.rejects(ops.run('session.follow', {}), (error) => {
    assert.equal(error.code, 'bad_args');
    return true;
  });
});

test('openStream maps onto gateway.stream', async () => {
  const { ops, fake } = makeOps({
    streams: { 'session.follow': async function* () { yield 1; } },
  });
  const iterable = await ops.openStream('session.follow', { address: { sessionId: 's1' } });
  const collected = [];
  for await (const chunk of iterable) collected.push(chunk);
  assert.deepEqual(collected, [1]);
  assert.equal(fake.calls[0].kind, 'stream');
  assert.equal(fake.calls[0].method, 'follow');
});

test('openStream refuses a non-streaming op', async () => {
  const { ops } = makeOps();
  await assert.rejects(ops.openStream('session.list', {}), (error) => {
    assert.equal(error.code, 'op_not_supported');
    return true;
  });
});

test('a gateway business error becomes remote_error and keeps the remote code in the message', async () => {
  const failing = () => {
    const error = new Error('session is gone');
    error.code = 'session/not-found';
    throw error;
  };
  const { ops, log } = makeOps({ ops: { 'session.page': failing } });
  await assert.rejects(ops.run('session.page', {}), (error) => {
    assert.ok(error instanceof OpError);
    assert.equal(error.code, 'remote_error');
    assert.match(error.message, /session\/not-found: session is gone/);
    return true;
  });
  assert.match(log.text(), /a Remote call failed/);
});

test('an aborted signal becomes cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const { ops } = makeOps({
    ops: {
      'session.list': () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
  });
  await assert.rejects(ops.run('session.list', {}, controller.signal), (error) => {
    assert.equal(error.code, 'cancelled');
    return true;
  });
});

test('a missing gateway is reported instead of crashing', async () => {
  const log = createMemoryLogger();
  const ops = createOps({ gateway: undefined, config: makeConfig(), log });
  await assert.rejects(ops.run('session.list', {}), (error) => {
    assert.equal(error.code, 'gateway_internal');
    return true;
  });
});

test('allowedSessions blocks a targeted op', async () => {
  const config = makeConfig({ allowedSessions: ['allowed-1'] });
  const { ops, fake } = makeOps({ config, ops: { 'session.prompt': () => ({ accepted: true }) } });

  assert.equal(ops.sessionAllowed('allowed-1'), true);
  assert.equal(ops.sessionAllowed('other'), false);

  await assert.rejects(ops.run('session.prompt', { sessionId: 'other' }), (error) => {
    assert.equal(error.code, 'session_not_allowed');
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

test('allowedSessions filters a session list', async () => {
  const config = makeConfig({ allowedSessions: ['keep'] });
  const { ops } = makeOps({
    config,
    ops: {
      'session.list': () => ({ items: [{ sessionId: 'keep' }, { sessionId: 'drop' }] }),
    },
  });
  const value = await ops.run('session.list', {});
  assert.deepEqual(value.items, [{ sessionId: 'keep' }]);
});

test('an empty allowlist permits every session', async () => {
  const { ops } = makeOps({ ops: { 'session.list': () => ({ items: [{ sessionId: 'anything' }] }) } });
  const value = await ops.run('session.list', {});
  assert.equal(value.items.length, 1);
  assert.equal(ops.sessionAllowed('anything'), true);
  assert.equal(ops.sessionAllowed(undefined), true);
});

// -- archived sessions -------------------------------------------------------
//
// `session.list` returns archived Sessions exactly like live ones, and the only
// place the archived set is published is the first frame of `workspace.follow`.
// The phone must not have to know any of that.

/** A Workspace feed whose baseline names [archivedIds]. */
function workspaceFeed(archivedIds, { onClose } = {}) {
  return async function* feed() {
    try {
      yield {
        type: 'baseline',
        value: { items: [], archivedSessionIds: archivedIds, pinnedSessionIds: [] },
      };
      // Increments follow in the real feed; nothing should ever read this far.
      yield { type: 'archived', archivedSessionIds: [...archivedIds, 'stale'] };
      throw new Error('the workspace stream was read past its baseline');
    } finally {
      onClose?.();
    }
  };
}

test('archived sessions are dropped from session.list', async () => {
  let closed = false;
  const { ops, fake } = makeOps({
    ops: {
      'session.list': () => ({
        items: [{ sessionId: 'live-1' }, { sessionId: 'arch-1' }, { sessionId: 'live-2' }],
      }),
    },
    streams: { 'workspace.follow': workspaceFeed(['arch-1'], { onClose: () => (closed = true) }) },
  });

  const value = await ops.run('session.list', {});

  assert.deepEqual(value.items.map((item) => item.sessionId), ['live-1', 'live-2']);
  // The removed ids ride along, which is what lets a verification assert that the
  // filter did something rather than that the list was short for another reason.
  assert.deepEqual(value.archivedSessionIds, ['arch-1']);
  assert.equal(fake.settledCalls('workspace.follow').length, 1, 'read once per list, not per row');
  assert.equal(closed, true, 'the one-frame read must close the stream again');
});

test('a list with nothing archived is returned untouched', async () => {
  const { ops } = makeOps({
    ops: { 'session.list': () => ({ items: [{ sessionId: 'a' }, { sessionId: 'b' }] }) },
    streams: { 'workspace.follow': workspaceFeed([]) },
  });
  const value = await ops.run('session.list', {});
  assert.equal(value.items.length, 2);
  // An empty set is still *reported*: the presence of the field is how a
  // verification distinguishes "nothing to hide" from "this build never looked".
  assert.deepEqual(value.archivedSessionIds, []);
});

test('an unreadable archived set reports no field at all', async () => {
  // The distinction that matters: no field means the archived set was never read.
  const { ops } = makeOps({
    ops: { 'session.list': () => ({ items: [{ sessionId: 'a' }] }) },
  });
  const value = await ops.run('session.list', {});
  assert.equal('archivedSessionIds' in value, false);
});

test('a Workspace feed that never answers cannot hang session.list', async () => {
  // A stream that yields nothing and ignores its abort signal would block the
  // phone's session list forever if the read were awaited directly.
  const { ops } = makeOps({
    ops: { 'session.list': () => ({ items: [{ sessionId: 'a' }, { sessionId: 'b' }] }) },
    streams: {
      'workspace.follow': () =>
        (async function* () {
          await new Promise(() => {});
        })(),
    },
  });

  const started = Date.now();
  const value = await ops.run('session.list', {});
  const elapsed = Date.now() - started;

  assert.equal(value.items.length, 2, 'the list is returned unfiltered');
  assert.equal('archivedSessionIds' in value, false);
  assert.ok(elapsed < 10_000, `the read must give up on its own (took ${elapsed}ms)`);
});

test('an unavailable workspace feed leaves the list intact', async () => {
  // No `workspace.follow` registered: the fake gateway throws, exactly as a DSH
  // build without the Workspace feed would.
  const { ops, log } = makeOps({
    ops: { 'session.list': () => ({ items: [{ sessionId: 'a' }, { sessionId: 'b' }] }) },
  });
  const value = await ops.run('session.list', {});
  assert.equal(value.items.length, 2, 'an unreadable archived set must not empty the list');
  assert.match(log.text(), /workspace\.follow baseline unavailable/);
});

test('a feed that yields no baseline is not fatal either', async () => {
  const { ops } = makeOps({
    ops: { 'session.list': () => ({ items: [{ sessionId: 'a' }] }) },
    streams: { 'workspace.follow': async function* () {} },
  });
  const value = await ops.run('session.list', {});
  assert.equal(value.items.length, 1);
});

test('hideArchivedSessions false lists them again and opens no stream', async () => {
  const { ops, fake } = makeOps({
    config: makeConfig({ hideArchivedSessions: false }),
    ops: {
      'session.list': () => ({ items: [{ sessionId: 'live-1' }, { sessionId: 'arch-1' }] }),
    },
    streams: { 'workspace.follow': workspaceFeed(['arch-1']) },
  });
  const value = await ops.run('session.list', {});
  assert.equal(value.items.length, 2);
  assert.equal(fake.settledCalls('workspace.follow').length, 0, 'the opt-out skips the read entirely');
});

test('the allowlist and the archived filter compose', async () => {
  const { ops } = makeOps({
    config: makeConfig({ allowedSessions: ['keep-1', 'arch-1'] }),
    ops: {
      'session.list': () => ({
        items: [{ sessionId: 'keep-1' }, { sessionId: 'arch-1' }, { sessionId: 'not-allowed' }],
      }),
    },
    streams: { 'workspace.follow': workspaceFeed(['arch-1']) },
  });
  const value = await ops.run('session.list', {});
  assert.deepEqual(value.items.map((item) => item.sessionId), ['keep-1']);
});

test('a non-list value survives the archived pass unchanged', async () => {
  const { ops } = makeOps({
    ops: { 'session.list': () => null },
    streams: { 'workspace.follow': workspaceFeed(['anything']) },
  });
  assert.equal(await ops.run('session.list', {}), null);
});

test('includeArchived returns everything and still names what is archived', async () => {
  // The comparison a verification makes: one call with the flag, one without.
  const { ops, fake } = makeOps({
    ops: {
      'session.list': () => ({
        items: [{ sessionId: 'live-1' }, { sessionId: 'arch-1' }],
      }),
    },
    streams: { 'workspace.follow': workspaceFeed(['arch-1']) },
  });

  const all = await ops.run('session.list', { includeArchived: true });
  assert.deepEqual(all.items.map((item) => item.sessionId), ['live-1', 'arch-1']);
  assert.deepEqual(all.archivedSessionIds, ['arch-1']);
  // The control key is ours: the Host's `session.list` declares only `{cursor?}`
  // and the gateway validates strictly, so leaking it would be a 400 on the real
  // host while every stub kept working.
  assert.deepEqual(fake.calls[0].args, { _request: {} });

  const visible = await ops.run('session.list', {});
  assert.deepEqual(visible.items.map((item) => item.sessionId), ['live-1']);
  assert.deepEqual(visible.archivedSessionIds, ['arch-1']);
  assert.equal(all.items.length - visible.items.length, visible.archivedSessionIds.length);
});

test('a control key does not disturb ordinary request parameters', async () => {
  const { ops, fake } = makeOps({ ops: { 'session.list': () => ({ items: [] }) } });
  await ops.run('session.list', { cursor: 'page-2', includeArchived: false });
  assert.deepEqual(fake.calls[0].args, { _request: { cursor: 'page-2' } });
});

test('harness.info reports the archived policy', async () => {
  const { ops } = makeOps({ harness: {} });
  assert.equal((await ops.run('harness.info')).hideArchivedSessions, true);
});

