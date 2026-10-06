/**
 * Wire contracts for the plugin <-> relay channel.
 *
 * This is the JavaScript half of `docs/PROTOCOL.md`; the Python half is
 * `backend/app/protocol.py`. Bump PROTOCOL_VERSION in both places, together.
 */

export const PROTOCOL_VERSION = 1;

export const CAP_OPS = 'ops';
export const CAP_EVENTS = 'events';
export const CAP_APPROVALS = 'approvals';
export const ALL_CAPABILITIES = Object.freeze([CAP_OPS, CAP_EVENTS, CAP_APPROVALS]);

/** Error codes carried in `res.error.code` / `stream.error.code`. */
export const ERROR = Object.freeze({
  OP_NOT_SUPPORTED: 'op_not_supported',
  BAD_ARGS: 'bad_args',
  REMOTE_ERROR: 'remote_error',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  LINK_LOST: 'link_lost',
  DEVICE_OFFLINE: 'device_offline',
  DEVICE_BUSY: 'device_busy',
  SESSION_NOT_ALLOWED: 'session_not_allowed',
  GATEWAY_INTERNAL: 'gateway_internal',
});

/** Event topics the relay may subscribe to. */
export const TOPIC = Object.freeze({
  SESSION_EVENT: 'session.event',
  SESSION_STATUS: 'session.status',
  SESSION_ACTIVITY: 'session.activity',
  APPROVAL_ASK: 'approval.ask',
  QUESTION_ASK: 'question.ask',
  APPROVAL_SETTLED: 'approval.settled',
  DEVICE_STATUS: 'device.status',
});

export const KNOWN_TOPICS = Object.freeze(new Set(Object.values(TOPIC)));

/** WebSocket close codes the relay uses during and after the handshake. */
export const CLOSE = Object.freeze({
  REPLACED: 4001,
  PROTOCOL: 4400,
  UNAUTHORIZED: 4401,
});

/**
 * Ops the plugin is allowed to forward.
 *
 * Keyed by wire op name; each entry names the exact DSH Remote it maps to.
 * There is deliberately no way to invoke an arbitrary namespace/method pair.
 *
 * `param` is the Remote's declared parameter name. The typert gateway validates
 * argument keys against the descriptor and rejects a mismatch, and DSH is not
 * consistent about the name: `session.list` declares `_request` while every other
 * session method declares `request`. Callers of this plugin pass the *request
 * object* directly; the bridge does the wrapping.
 */
export const OP_TABLE = Object.freeze({
  'session.list': { namespace: 'session', method: 'list', param: '_request' },
  'session.page': { namespace: 'session', method: 'page', param: 'request' },
  'session.follow': { namespace: 'session', method: 'follow', param: 'request', stream: true },
  'session.prompt': { namespace: 'session', method: 'prompt', param: 'request' },
  'session.cancel': { namespace: 'session', method: 'cancel', param: 'request' },
  'session.create': { namespace: 'session', method: 'create', param: 'request' },
  // Switching the model is its own call — `session.prompt` has no model argument,
  // which is why an earlier version of the app wrongly concluded the desktop
  // offered no model switching at all.
  'session.selectModel': { namespace: 'session', method: 'selectModel', param: 'request' },
  // Delivers a phone answer for an `ask_user_question` call. Three wire
  // parameters rather than one request object, so it declares `wires` and the
  // caller passes a map keyed by wire name. The third parameter is named
  // `answer` (type `AskUserQuestionAnswer`), not `request`.
  'userQuestions.answer': {
    namespace: 'userQuestions',
    method: 'answer',
    wires: ['agentId', 'callId', 'answer'],
  },
  'model.catalog': { namespace: 'session', method: 'modelCatalog' },
  // Archiving is a **Workspace registry** operation, not a session one: a session
  // cannot archive itself, and there is no `session.archive`. That registry is also
  // the only thing that knows which Sessions `session.list` is hiding, which is why
  // the list has to read `workspace.follow` to find them.
  //
  // `archiveSession` takes `{sessionId, stopActivity?}`. Without `stopActivity` it
  // *refuses* a Session with running work (`workspace/session-active`, with the work
  // listed in `details`) — which is what lets the phone ask before it kills a turn
  // instead of guessing. `unarchiveSession` takes `{sessionId}` and answers the
  // updated set as `{archivedSessionIds}`.
  'workspace.archiveSession': {
    namespace: 'workspace',
    method: 'archiveSession',
    param: 'request',
  },
  'workspace.unarchiveSession': {
    namespace: 'workspace',
    method: 'unarchiveSession',
    param: 'request',
  },
  // Stages one generic file for a later prompt. Two wire parameters, and the
  // request is `{ data, name? }` where `data` is **base64 of the raw bytes**
  // (`@deepseek-ai/dsh-client-file-upload/lib/client.js:193-196` does
  // `bytesToBase64(data)` before calling this Remote). The result carries the
  // `receiptId` that `session.prompt` consumes as a `{type:'file', receiptId}`
  // content block.
  //
  // Images do **not** need this: `session.prompt` accepts
  // `{type:'image', mediaType, data}` inline, where `data` is base64 too.
  'fileUploads.upload': {
    namespace: 'fileUploads',
    method: 'upload',
    wires: ['agentId', 'request'],
  },
});

export const LOCAL_OPS = Object.freeze(new Set(['harness.info']));
export const ALLOWED_OPS = Object.freeze(new Set([...Object.keys(OP_TABLE), ...LOCAL_OPS]));
export const STREAM_OPS = Object.freeze(
  new Set(Object.entries(OP_TABLE).filter(([, v]) => v.stream).map(([k]) => k)),
);

/** Frames the relay may send us. */
const SERVER_FRAME_TYPES = new Set([
  'welcome',
  'bye',
  'req',
  'cancel',
  'sub',
  'unsub',
  'approval',
  'ping',
]);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function newId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
}

export function encode(frame) {
  return JSON.stringify(frame);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode one relay frame.
 * @returns {{ok: true, frame: object} | {ok: false, error: ProtocolError}}
 */
export function decode(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, 'frame is not valid JSON') };
  }
  if (!isPlainObject(parsed) || typeof parsed.t !== 'string') {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, 'frame must be an object with a string "t"') };
  }
  if (!SERVER_FRAME_TYPES.has(parsed.t)) {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, `unsupported frame type ${parsed.t}`) };
  }
  if ('id' in parsed && typeof parsed.id !== 'string') {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, 'frame "id" must be a string') };
  }
  if (parsed.t === 'req' && typeof parsed.op !== 'string') {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, 'req.op must be a string') };
  }
  if (parsed.t === 'sub' && !Array.isArray(parsed.topics)) {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, 'sub.topics must be an array') };
  }
  if (parsed.t === 'approval' && typeof parsed.askId !== 'string') {
    return { ok: false, error: new ProtocolError(ERROR.BAD_ARGS, 'approval.askId must be a string') };
  }
  return { ok: true, frame: parsed };
}

/** Build the attach URL, preserving any query already present in serverUrl. */
export function attachUrl(serverUrl, token) {
  const url = new URL(serverUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export function errorFrame(id, code, message) {
  return { t: 'res', id, ok: false, error: { code, message } };
}

export function okFrame(id, value) {
  return { t: 'res', id, ok: true, value: value === undefined ? null : value };
}

export function streamFrame(id, phase, payload = {}) {
  return { t: 'stream', id, phase, ...payload };
}

export function evtFrame(topic, payload) {
  return { t: 'evt', topic, payload };
}
