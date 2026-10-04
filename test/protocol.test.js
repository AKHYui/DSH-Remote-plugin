import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_OPS,
  CLOSE,
  ERROR,
  KNOWN_TOPICS,
  OP_TABLE,
  PROTOCOL_VERSION,
  STREAM_OPS,
  ProtocolError,
  attachUrl,
  decode,
  encode,
  errorFrame,
  evtFrame,
  okFrame,
  streamFrame,
} from '../src/protocol.js';
import { backoffDelay } from '../src/link.js';

test('every server frame type decodes', () => {
  const frames = [
    { t: 'welcome', v: PROTOCOL_VERSION, deviceId: 'dev-1', serverTime: 1 },
    { t: 'bye', code: 'x', message: 'y' },
    { t: 'req', id: 'r1', op: 'session.list', args: {} },
    { t: 'cancel', id: 'r1' },
    { t: 'sub', id: 's1', topics: ['session.event'], args: {} },
    { t: 'unsub', id: 's1' },
    { t: 'approval', askId: 'a1', decision: 'approved' },
    { t: 'ping', id: 'p1' },
  ];
  for (const frame of frames) {
    const result = decode(encode(frame));
    assert.equal(result.ok, true, `expected ${frame.t} to decode`);
    assert.equal(result.frame.t, frame.t);
  }
});

test('decode rejects malformed input', () => {
  const cases = [
    ['not json', /valid JSON/],
    ['[]', /must be an object/],
    ['{}', /must be an object with a string "t"/],
    ['{"t":"nope"}', /unsupported frame type/],
    ['{"t":"req","id":5,"op":"x"}', /"id" must be a string/],
    ['{"t":"req","id":"r1"}', /req\.op must be a string/],
    ['{"t":"sub","id":"s1"}', /sub\.topics must be an array/],
    ['{"t":"approval","decision":"approved"}', /approval\.askId must be a string/],
  ];
  for (const [input, pattern] of cases) {
    const result = decode(input);
    assert.equal(result.ok, false, `expected ${input} to be rejected`);
    assert.ok(result.error instanceof ProtocolError);
    assert.match(result.error.message, pattern);
  }
});

test('decode tolerates unknown extra fields', () => {
  const result = decode('{"t":"ping","id":"p1","future":true}');
  assert.equal(result.ok, true);
  assert.equal(result.frame.future, true);
});

test('attachUrl sets the token without destroying an existing query', () => {
  assert.equal(
    attachUrl('wss://relay.example.com/api/v1/attach', 'tok en/+'),
    'wss://relay.example.com/api/v1/attach?token=tok+en%2F%2B',
  );
  assert.equal(
    attachUrl('wss://relay.example.com/api/v1/attach?channel=a', 'abc'),
    'wss://relay.example.com/api/v1/attach?channel=a&token=abc',
  );
});

test('frame builders produce the documented shapes', () => {
  assert.deepEqual(okFrame('r1', undefined), { t: 'res', id: 'r1', ok: true, value: null });
  assert.deepEqual(okFrame('r1', { a: 1 }), { t: 'res', id: 'r1', ok: true, value: { a: 1 } });
  assert.deepEqual(errorFrame('r1', ERROR.TIMEOUT, 'late'), {
    t: 'res',
    id: 'r1',
    ok: false,
    error: { code: 'timeout', message: 'late' },
  });
  assert.deepEqual(streamFrame('s1', 'chunk', { value: 1 }), {
    t: 'stream',
    id: 's1',
    phase: 'chunk',
    value: 1,
  });
  assert.deepEqual(evtFrame('session.event', { seq: 1 }), {
    t: 'evt',
    topic: 'session.event',
    payload: { seq: 1 },
  });
});

test('the op allowlist and the op table agree', () => {
  // Namespaces a phone may reach. Listed explicitly so the "no arbitrary
  // namespace/method pair" property survives the table growing beyond `session`.
  const ALLOWED_NAMESPACES = new Set(['session', 'userQuestions', 'fileUploads']);

  for (const op of Object.keys(OP_TABLE)) {
    assert.ok(ALLOWED_OPS.has(op), `${op} must be in ALLOWED_OPS`);
    const entry = OP_TABLE[op];
    assert.ok(
      ALLOWED_NAMESPACES.has(entry.namespace),
      `${op} reaches an unvetted namespace: ${entry.namespace}`,
    );
    assert.equal(typeof entry.method, 'string');
    // Either an explicit list of wire parameters, or a single request-object
    // name, or genuinely no arguments (`model.catalog` has none).
    if (Array.isArray(entry.wires)) {
      assert.ok(entry.wires.length > 0, `${op} declares an empty wires list`);
    } else if (entry.param !== undefined) {
      assert.ok(
        typeof entry.param === 'string' && entry.param.length > 0,
        `${op} param must be a non-empty wire name`,
      );
    }
  }
  assert.ok(ALLOWED_OPS.has('harness.info'));
  assert.ok(STREAM_OPS.has('session.follow'));
  assert.equal(STREAM_OPS.size, 1);
  // No arbitrary namespace/method pair can be reached.
  assert.ok(!ALLOWED_OPS.has('session.attachment'));
  assert.ok(!ALLOWED_OPS.has('terminal.create'));
});

test('only documented topics are recognised', () => {
  assert.ok(KNOWN_TOPICS.has('session.event'));
  assert.ok(KNOWN_TOPICS.has('approval.ask'));
  assert.ok(KNOWN_TOPICS.has('question.ask'));
  assert.ok(!KNOWN_TOPICS.has('session.unknown'));
});

test('close codes match the documented contract', () => {
  assert.equal(CLOSE.REPLACED, 4001);
  assert.equal(CLOSE.PROTOCOL, 4400);
  assert.equal(CLOSE.UNAUTHORIZED, 4401);
});

test('backoff grows exponentially and is capped', () => {
  const mid = () => 0.5;
  assert.equal(backoffDelay(1, mid), 1_000);
  assert.equal(backoffDelay(2, mid), 2_000);
  assert.equal(backoffDelay(3, mid), 4_000);
  assert.equal(backoffDelay(4, mid), 8_000);
  assert.equal(backoffDelay(6, mid), 30_000);
  assert.equal(backoffDelay(50, mid), 30_000);
  assert.equal(backoffDelay(0, mid), 1_000);
});

test('backoff jitter stays within +/-20%', () => {
  const low = backoffDelay(3, () => 0);
  const high = backoffDelay(3, () => 1);
  assert.equal(low, 3_200);
  assert.equal(high, 4_800);
});
