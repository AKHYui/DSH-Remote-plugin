import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopWithdraw } from '../src/desktop-withdraw.js';
import { createFakeTimers, flush } from '../tools/fake-ctx.mjs';

/**
 * A stand-in for the host gateway's forwarded-event bookkeeping.
 *
 * Only the shape this module is allowed to touch: `pendingRemoteEvents` keyed by
 * id, and `finishRemoteEvent`. The real one lives in
 * `@deepseek-ai/dsh-api-gateway/lib/index.js`.
 */
function makeGateway({ withFinish = true, withCancel = false } = {}) {
  const pendingRemoteEvents = new Map();
  const finished = [];
  const cancelled = [];
  const gateway = {
    pendingRemoteEvents,
    finished,
    cancelled,
    add({ id, event = 'approval/request', agentId = 'sess-1', request = {}, callId }) {
      const pending = {
        id,
        source: { event, request, context: { agentId } },
        frame: { type: 'waterfall', event, eventId: id, agentId, request: { callId } },
      };
      pendingRemoteEvents.set(id, pending);
      return pending;
    },
  };
  if (withFinish) {
    gateway.finishRemoteEvent = (pending) => {
      finished.push(pending.id);
      pendingRemoteEvents.delete(pending.id);
    };
  }
  if (withCancel) {
    gateway.cancelRemoteEvent = (pending, reason) => {
      cancelled.push({ id: pending.id, reason });
      pendingRemoteEvents.delete(pending.id);
    };
  }
  return gateway;
}

function make({ gateway, attempts = 3, retryMs = 60 } = {}) {
  const timers = createFakeTimers();
  const withdraw = createDesktopWithdraw({ gateway, timers, attempts, retryMs });
  return { ...withdraw, timers };
}

test('the request object identity is what matches', () => {
  const gateway = makeGateway();
  const request = { agent: { id: 'sess-1' }, toolName: 'pwsh', callId: 'call-1' };
  gateway.add({ id: 'evt-1', request });
  const { withdraw } = make({ gateway });

  assert.equal(withdraw(request, 'approval/request'), true);
  assert.deepEqual(gateway.finished, ['evt-1']);
  assert.equal(gateway.pendingRemoteEvents.size, 0);
});

test('a request object that is not the forwarded one is left alone', () => {
  const gateway = makeGateway();
  gateway.add({ id: 'evt-1', request: { agent: { id: 'sess-1' } } });
  const { withdraw } = make({ gateway });

  // Same session and call, different object: the loose match must not fire when
  // there is no callId to corroborate it... but here there is none on either
  // side, so this documents the fallback rather than the identity path.
  assert.equal(withdraw({ agent: { id: 'sess-2' } }, 'approval/request'), false);
  assert.deepEqual(gateway.finished, []);
});

test('an event name that does not match is never finished', () => {
  const gateway = makeGateway();
  const request = { agent: { id: 'sess-1' } };
  gateway.add({ id: 'evt-1', event: 'user-questions/request', request });
  const { withdraw } = make({ gateway });

  assert.equal(withdraw(request, 'approval/request'), false);
  assert.deepEqual(gateway.finished, []);
});

test('a clone of the request still matches by agent and call', () => {
  const gateway = makeGateway();
  const original = { agent: { id: 'sess-1' }, toolName: 'pwsh', callId: 'call-9' };
  gateway.add({ id: 'evt-1', request: original, callId: 'call-9' });
  const { withdraw } = make({ gateway });

  const clone = { ...original, agent: { id: 'sess-1' } };
  assert.equal(withdraw(clone, 'approval/request'), true);
  assert.deepEqual(gateway.finished, ['evt-1']);
});

test('a pending record that appears late is still finished', async () => {
  // `next()` only queues the forward; the host turns it into a pending record on
  // a later microtask. A phone on a warm connection can therefore answer first.
  const gateway = makeGateway();
  const request = { agent: { id: 'sess-1' }, toolName: 'pwsh' };
  const { withdraw, timers } = make({ gateway, attempts: 3, retryMs: 60 });

  assert.equal(withdraw(request, 'approval/request'), false);
  assert.equal(gateway.finished.length, 0);
  assert.equal(timers.pendingCount(), 1);

  gateway.add({ id: 'evt-late', request });
  timers.runNext();
  await flush();

  assert.deepEqual(gateway.finished, ['evt-late']);
  assert.equal(timers.pendingCount(), 0, 'no further retry is scheduled');
});

test('retries are bounded and stop when nothing ever appears', async () => {
  const gateway = makeGateway();
  const { withdraw, timers } = make({ gateway, attempts: 3, retryMs: 60 });

  withdraw({ agent: { id: 'sess-1' }, toolName: 'pwsh' }, 'approval/request');
  const delays = timers.runAll();
  await flush();

  assert.deepEqual(delays, [60, 60, 60], 'exactly `attempts` retries');
  assert.equal(timers.pendingCount(), 0);
  assert.deepEqual(gateway.finished, []);
});

test('dispose cancels the retries the bridge armed', () => {
  const gateway = makeGateway();
  const { withdraw, timers, dispose } = make({ gateway, attempts: 5, retryMs: 60 });
  withdraw({ agent: { id: 'sess-1' } }, 'approval/request');
  assert.equal(timers.pendingCount(), 1);

  dispose();
  assert.equal(timers.pendingCount(), 0);
});

test('a gateway that was already told about it is not told twice', () => {
  const gateway = makeGateway();
  const request = { agent: { id: 'sess-1' } };
  gateway.add({ id: 'evt-1', request });
  const { withdraw } = make({ gateway });

  assert.equal(withdraw(request, 'approval/request'), true);
  // The record is gone now, so the second attempt must be a no-op rather than a
  // second cancel frame for an id the client already dropped.
  assert.equal(withdraw(request, 'approval/request'), false);
  assert.deepEqual(gateway.finished, ['evt-1']);
});

test('cancelRemoteEvent is used when finishRemoteEvent is absent', () => {
  const gateway = makeGateway({ withFinish: false, withCancel: true });
  const request = { agent: { id: 'sess-1' } };
  gateway.add({ id: 'evt-1', request });
  const { withdraw } = make({ gateway });

  assert.equal(withdraw(request, 'approval/request'), true);
  assert.deepEqual(
    gateway.cancelled.map((entry) => entry.id),
    ['evt-1'],
  );
  assert.match(gateway.cancelled[0].reason.message, /phone answered/);
});

test('an unknown gateway shape is a no-op, not a crash', async () => {
  for (const gateway of [undefined, null, {}, { pendingRemoteEvents: [] }]) {
    const { withdraw, timers } = make({ gateway });
    assert.equal(withdraw({ agent: { id: 's1' } }, 'approval/request'), false);
    assert.equal(timers.pendingCount(), 0, 'no retries without the service');
    await flush();
  }
});

test('a gateway whose internals throw is contained', () => {
  const gateway = makeGateway();
  const request = { agent: { id: 'sess-1' } };
  gateway.add({ id: 'evt-1', request });
  gateway.finishRemoteEvent = () => {
    throw new Error('internal shape changed');
  };
  const { withdraw } = make({ gateway });

  assert.equal(withdraw(request, 'approval/request'), false);
});

test('the lazy gateway thunk is resolved per attempt', () => {
  const gateway = makeGateway();
  const request = { agent: { id: 'sess-1' } };
  let resolved = null;
  const { withdraw } = make({ gateway: () => resolved });

  assert.equal(withdraw(request, 'approval/request'), false, 'service is not up yet');
  resolved = gateway;
  gateway.add({ id: 'evt-1', request });
  assert.equal(withdraw(request, 'approval/request'), true);
  assert.deepEqual(gateway.finished, ['evt-1']);
});

test('an ambiguous fallback cancels nothing', () => {
  // Two forwarded questions for the same session, neither of them the object we
  // hold (a question request carries no callId to tell them apart): guessing
  // would take down the wrong window.
  const gateway = makeGateway();
  gateway.add({ id: 'evt-1', event: 'user-questions/request', agentId: 'sess-1' });
  gateway.add({ id: 'evt-2', event: 'user-questions/request', agentId: 'sess-1' });
  const { withdraw } = make({ gateway });

  assert.equal(withdraw({ agent: { id: 'sess-1' }, questions: [] }, 'user-questions/request'), false);
  assert.deepEqual(gateway.finished, []);
});

test('status reports the shape the withdrawal depends on', () => {
  const gateway = makeGateway();
  assert.deepEqual(make({ gateway }).status(), {
    gateway: true,
    pendingTable: 0,
    finishRemoteEvent: true,
    cancelRemoteEvent: false,
  });

  // The one line the debug log needs to tell "not supported by this build" from
  // "supported and the prompt still stayed".
  assert.deepEqual(make({ gateway: undefined }).status(), {
    gateway: false,
    pendingTable: null,
    finishRemoteEvent: false,
    cancelRemoteEvent: false,
  });
  assert.deepEqual(make({ gateway: {} }).status(), {
    gateway: true,
    pendingTable: null,
    finishRemoteEvent: false,
    cancelRemoteEvent: false,
  });
});
