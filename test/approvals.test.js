import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovals } from '../src/approvals.js';
import { createMemoryLogger } from '../src/log.js';
import { createFakeCtx, createFakeTimers, flush } from '../tools/fake-ctx.mjs';

function makeApprovals({ timeoutMs = 5_000, ready = true } = {}) {
  const timers = createFakeTimers();
  const log = createMemoryLogger();
  const approvals = createApprovals({ log, timeoutMs, timers, now: () => 1_000 });
  const sent = [];
  approvals.setSender(async (topic, payload) => {
    sent.push({ topic, payload });
  });
  approvals.setReady(() => ready);
  return { approvals, timers, sent, log };
}

test('a phone decision settles a pending ask', async () => {
  const { approvals, sent } = makeApprovals();
  const pending = approvals.ask({ topic: 'approval.ask', body: { toolName: 'pwsh', sessionId: 's1' } });
  await flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'approval.ask');
  assert.equal(sent[0].payload.toolName, 'pwsh');
  assert.equal(typeof sent[0].payload.askId, 'string');
  assert.equal(typeof sent[0].payload.deadline, 'number');

  assert.equal(approvals.resolve({ askId: sent[0].payload.askId, decision: 'approved' }), true);
  const decision = await pending;
  assert.equal(decision.decision, 'approved');

  await flush();
  assert.equal(sent[1].topic, 'approval.settled');
  assert.equal(sent[1].payload.by, 'phone');
  assert.equal(approvals.stats().answered, 1);
});

test('an unknown ask id is refused', async () => {
  const { approvals } = makeApprovals();
  assert.equal(approvals.resolve({ askId: 'nope', decision: 'approved' }), false);
  assert.equal(approvals.resolve({ decision: 'approved' }), false);
  assert.equal(approvals.resolve(null), false);
});

test('an ask is single-use', async () => {
  const { approvals, sent } = makeApprovals();
  const pending = approvals.ask({ topic: 'approval.ask', body: {} });
  await flush();
  const askId = sent[0].payload.askId;
  assert.equal(approvals.resolve({ askId, decision: 'approved' }), true);
  assert.equal(approvals.resolve({ askId, decision: 'denied' }), false);
  await pending;
});

test('a timeout defers to the desktop', async () => {
  const { approvals, timers, sent } = makeApprovals({ timeoutMs: 5_000 });
  const pending = approvals.ask({ topic: 'approval.ask', body: {} });
  await flush();

  assert.equal(timers.runNext(), 5_000);
  const decision = await pending;
  assert.equal(decision, null);

  await flush();
  assert.equal(sent[1].payload.by, 'timeout');
  assert.equal(approvals.stats().timedOut, 1);
  assert.equal(approvals.stats().pending, 0);
});

test('an aborted ask signal defers immediately', async () => {
  const { approvals, sent } = makeApprovals();
  const controller = new AbortController();
  const pending = approvals.ask({ topic: 'approval.ask', body: {}, signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal(await pending, null);
  await flush();
  assert.equal(sent[1].payload.by, 'cancelled');
  assert.equal(approvals.stats().cancelled, 1);
});

test('an already-aborted signal never sends an ask', async () => {
  const { approvals, sent } = makeApprovals();
  const controller = new AbortController();
  controller.abort();
  const decision = await approvals.ask({ topic: 'approval.ask', body: {}, signal: controller.signal });
  assert.equal(decision, null);
  assert.equal(sent.length, 0);
});

test('cancelAll releases pending asks', async () => {
  const { approvals, sent } = makeApprovals();
  const first = approvals.ask({ topic: 'approval.ask', body: {} });
  const second = approvals.ask({ topic: 'question.ask', body: {} });
  await flush();
  assert.equal(approvals.stats().pending, 2);

  assert.equal(approvals.cancelAll('link down'), 2);
  assert.equal(await first, null);
  assert.equal(await second, null);
  await flush();
  assert.equal(sent.filter((frame) => frame.topic === 'approval.settled').length, 2);
});

test('an ask is skipped entirely when the link is not ready', async () => {
  const { approvals, sent } = makeApprovals({ ready: false });
  assert.equal(await approvals.ask({ topic: 'approval.ask', body: {} }), null);
  assert.equal(sent.length, 0);
});

test('a failing sender defers instead of hanging', async () => {
  const timers = createFakeTimers();
  const log = createMemoryLogger();
  const approvals = createApprovals({ log, timeoutMs: 5_000, timers, now: () => 1_000 });
  approvals.setSender(async () => {
    throw new Error('socket gone');
  });
  approvals.setReady(() => true);

  const decision = await approvals.ask({ topic: 'approval.ask', body: {} });
  assert.equal(decision, null);
  assert.equal(approvals.stats().linkLost, 1);
});

// --------------------------------------------------------------------------- //
// waterfall integration
// --------------------------------------------------------------------------- //

function attachTo(approvals, { sessionAllowed = () => true } = {}) {
  approvals.setSessionAllowed(sessionAllowed);
  const fake = createFakeCtx();
  const dispose = approvals.attach(fake.ctx);
  return { fake, dispose };
}

test('the waterfalls are prepended so the phone is offered the ask first', () => {
  // This is the fix for the real failure. Cordis keeps hook order and hands a
  // waterfall's `next` only to its FIRST listener; the built-in remote forwarder
  // registers first and never calls `next` once the desktop answers, so this
  // plugin's handler sat in the hook table but was permanently unreachable.
  const { approvals } = makeApprovals();
  const { fake } = attachTo(approvals);
  for (const name of ['approval/request', 'user-questions/request']) {
    const handler = fake.listener(name);
    assert.equal(fake.optionsFor(handler)?.prepend, true, `${name} must prepend`);
  }
});

test('a prepended listener is consulted before an earlier one', () => {
  const scope = createFakeCtx();
  const order = [];
  scope.ctx.on('user-questions/request', () => order.push('built-in'));
  scope.ctx.on('user-questions/request', () => order.push('phone'), { prepend: true });
  scope.emit('user-questions/request');
  assert.deepEqual(order, ['phone', 'built-in']);
});

test('attach joins both waterfalls and the agent lifecycle', () => {
  const { approvals } = makeApprovals();
  const { fake } = attachTo(approvals);
  assert.deepEqual(fake.eventNames().sort(), [
    // The plugin's own context: enough for the simulator.
    'agent/created',
    'agent/disposed',
    'approval/request',
    'user-questions/request',
  ]);
});

test('a created agent does not add a second waterfall binding', () => {
  // Regression. An earlier version also bound the waterfalls on `agent.ctx` (and
  // on `ctx.root`) after wrongly concluding that scope visibility was hiding
  // them. Cordis keeps a single global hook table, so all three bindings received
  // the event and the phone got up to three copies of the same ask.
  const { approvals } = makeApprovals();
  const { fake } = attachTo(approvals);
  const agentScope = createFakeCtx();

  fake.emit('agent/created', { agent: { id: 'sess-1', ctx: agentScope.ctx } });

  assert.deepEqual(agentScope.eventNames(), [], 'the agent scope must stay clean');
  assert.equal(fake.listenerCount('approval/request'), 1);
  assert.equal(fake.listenerCount('user-questions/request'), 1);
});

test('one request produces exactly one ask frame', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  fake.emit('agent/created', { agent: { id: 'sess-1', ctx: createFakeCtx().ctx } });

  const handler = fake.listener('approval/request');
  handler({ agent: { id: 'sess-1' }, toolName: 'pwsh' }, async () => 'unavailable');
  await flush();

  assert.equal(sent.filter((f) => f.topic === 'approval.ask').length, 1);
});

test('nothing is bound twice, even when the context has a root', () => {
  // Regression, the second half of the same mistake. `agent/created` was also
  // bound on `ctx.root` "to see which one fires"; with one global hook table both
  // fired, so the debug log printed every lifecycle line twice. The fake context
  // now has a root that shares the registration path, which is what makes this
  // observable at all.
  const { approvals } = makeApprovals();
  const fake = createFakeCtx({ withRoot: true });
  approvals.setSessionAllowed(() => true);
  approvals.attach(fake.ctx);

  for (const name of [
    'approval/request',
    'user-questions/request',
    'agent/created',
    'agent/disposed',
  ]) {
    assert.equal(fake.listenerCount(name), 1, `${name} must be bound exactly once`);
  }
});

test('a disposed agent is forgotten without disturbing the binding', () => {
  const { approvals } = makeApprovals();
  const { fake } = attachTo(approvals);
  fake.emit('agent/created', { agent: { id: 'sess-1', ctx: createFakeCtx().ctx } });
  fake.emit('agent/disposed', { agent: { id: 'sess-1' } });
  // Re-creating the same agent must still not duplicate anything.
  fake.emit('agent/created', { agent: { id: 'sess-1', ctx: createFakeCtx().ctx } });
  assert.equal(fake.listenerCount('approval/request'), 1);
});

test('an agent without a scoped context does not break attach', () => {
  const { approvals } = makeApprovals();
  const { fake } = attachTo(approvals);
  fake.emit('agent/created', { agent: { id: 'sess-1' } });
  assert.ok(true);
});

test('approval/request claims the request when the phone approves', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  const handler = fake.listener('approval/request');

  let nextCalled = false;
  const pending = handler(
    { agent: { id: 'sess-1' }, toolName: 'pwsh', callId: 'call-1', reason: 'needs a shell' },
    async () => {
      nextCalled = true;
      return 'unavailable';
    },
  );

  await flush();
  assert.equal(sent[0].topic, 'approval.ask');
  assert.equal(sent[0].payload.sessionId, 'sess-1');
  assert.equal(sent[0].payload.callId, 'call-1');

  approvals.resolve({ askId: sent[0].payload.askId, decision: 'approved' });
  assert.equal(await pending, 'allowed-once');
  // Both surfaces must prompt, so the desktop is handed the request straight
  // away rather than only after the phone gives up. Whichever answers first
  // wins; here the phone does, even though the desktop answered "unavailable"
  // immediately (which is an absence of an answer, not a submission).
  assert.equal(nextCalled, true);
});

test('approval/request maps every decision', async () => {
  for (const [decision, expected] of [
    ['approved', 'allowed-once'],
    ['denied', 'rejected'],
    ['cancelled', 'cancelled'],
    ['nonsense', 'unavailable'],
  ]) {
    const { approvals, sent } = makeApprovals();
    const { fake } = attachTo(approvals);
    const pending = fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'unavailable');
    await flush();
    approvals.resolve({ askId: sent[0].payload.askId, decision });
    assert.equal(await pending, expected, `decision ${decision}`);
  }
});

test('approval/request defers when no phone answers', async () => {
  const { approvals, timers } = makeApprovals({ timeoutMs: 5_000 });
  const { fake } = attachTo(approvals);
  const pending = fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'unavailable');
  await flush();
  timers.runNext();
  assert.equal(await pending, 'unavailable');
});

test('approval/request defers for a session outside the allowlist', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals, { sessionAllowed: () => false });
  const outcome = await fake.listener('approval/request')(
    { agent: { id: 'blocked' }, toolName: 'pwsh' },
    async () => 'unavailable',
  );
  assert.equal(outcome, 'unavailable');
  assert.equal(sent.length, 0, 'no ask is sent for a session we may not see');
});

test('approval/request defers when the link is not ready', async () => {
  const { approvals, sent } = makeApprovals({ ready: false });
  const { fake } = attachTo(approvals);
  const outcome = await fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'unavailable');
  assert.equal(outcome, 'unavailable');
  assert.equal(sent.length, 0);
});

test('user-questions/request returns the phone answers', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  const questions = [{ id: 'q1', question: 'Which one?', options: [{ label: 'a' }, { label: 'b' }] }];
  const pending = fake.listener('user-questions/request')({ agent: { id: 's1' }, questions }, async () => {
    throw new Error('must not be reached');
  });

  await flush();
  assert.equal(sent[0].topic, 'question.ask');
  assert.deepEqual(sent[0].payload.questions, questions);

  approvals.resolve({
    askId: sent[0].payload.askId,
    decision: 'approved',
    answers: [{ id: 'q1', selected: ['b'] }],
  });
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['b'] }] });
});

test('user-questions/request defers on cancel and on timeout', async () => {
  for (const mode of ['timeout', 'cancelled']) {
    const { approvals, sent, timers } = makeApprovals({ timeoutMs: 5_000 });
    const { fake } = attachTo(approvals);
    const pending = fake.listener('user-questions/request')({ agent: { id: 's1' }, questions: [] }, async () => 'delegated');
    await flush();
    if (mode === 'timeout') timers.runNext();
    else approvals.resolve({ askId: sent[0].payload.askId, decision: 'cancelled' });
    assert.equal(await pending, 'delegated', mode);
  }
});

test('user-questions/request always yields an answers array', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  const pending = fake.listener('user-questions/request')({ agent: { id: 's1' }, questions: [] }, async () => 'delegated');
  await flush();
  approvals.resolve({ askId: sent[0].payload.askId, decision: 'approved' });
  assert.deepEqual(await pending, { answers: [] });
});

test('the phone winning takes the desktop prompt down', async () => {
  // Regression for the reported defect: both surfaces prompt, the phone submits
  // first, and the desktop window stayed open forever because it is waiting on
  // *its own* request — which nothing will ever answer now.
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  const withdrawn = [];
  approvals.setDesktopWithdraw((request, event) => withdrawn.push({ request, event }));

  const request = { agent: { id: 'sess-1' }, toolName: 'pwsh', callId: 'call-1' };
  const pending = fake.listener('approval/request')(request, async () => 'unavailable');
  await flush();
  approvals.resolve({ askId: sent[0].payload.askId, decision: 'approved' });

  assert.equal(await pending, 'allowed-once');
  assert.deepEqual(withdrawn, [{ request, event: 'approval/request' }]);
});

test('a question answered on the phone withdraws the desktop question panel', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  const withdrawn = [];
  approvals.setDesktopWithdraw((request, event) => withdrawn.push({ request, event }));

  const request = { agent: { id: 'sess-1' }, questions: [{ id: 'q1' }] };
  const pending = fake.listener('user-questions/request')(request, async () => 'unavailable');
  await flush();
  approvals.resolve({ askId: sent[0].payload.askId, decision: 'approved', answers: [{ id: 'q1' }] });

  assert.deepEqual(await pending, { answers: [{ id: 'q1' }] });
  assert.deepEqual(withdrawn, [{ request, event: 'user-questions/request' }]);
});

test('the desktop winning does not withdraw its own prompt', async () => {
  const { approvals } = makeApprovals();
  const { fake } = attachTo(approvals);
  const withdrawn = [];
  approvals.setDesktopWithdraw((request, event) => withdrawn.push({ request, event }));

  const outcome = await fake.listener('approval/request')(
    { agent: { id: 'sess-1' }, toolName: 'pwsh' },
    async () => 'allowed-once',
  );

  assert.equal(outcome, 'allowed-once');
  assert.deepEqual(withdrawn, [], 'the desktop answered, so nothing has to be taken down');
});

test('a timeout leaves the desktop as the only answerer', async () => {
  const { approvals, timers } = makeApprovals({ timeoutMs: 5_000 });
  const { fake } = attachTo(approvals);
  const withdrawn = [];
  approvals.setDesktopWithdraw((request, event) => withdrawn.push({ request, event }));

  const pending = fake.listener('approval/request')(
    { agent: { id: 'sess-1' }, toolName: 'pwsh' },
    async () => 'unavailable',
  );
  await flush();
  timers.runNext();

  assert.equal(await pending, 'unavailable');
  assert.deepEqual(withdrawn, []);
});

test('a failing withdrawer cannot break the answer', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake } = attachTo(approvals);
  approvals.setDesktopWithdraw(() => {
    throw new Error('the gateway internals moved');
  });

  const pending = fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'unavailable');
  await flush();
  approvals.resolve({ askId: sent[0].payload.askId, decision: 'approved' });
  assert.equal(await pending, 'allowed-once');
});

test('the disposer releases pending asks and detaches', async () => {
  const { approvals, sent } = makeApprovals();
  const { fake, dispose } = attachTo(approvals);
  const pending = fake.listener('approval/request')({ agent: { id: 's1' }, toolName: 'pwsh' }, async () => 'delegated');
  await flush();

  dispose();
  assert.equal(await pending, 'delegated', 'a pending ask is released on dispose');
  assert.equal(fake.listenerCount('approval/request'), 0);
  assert.equal(sent[0].topic, 'approval.ask');
});
