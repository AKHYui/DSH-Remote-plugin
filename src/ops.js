/**
 * Op dispatch onto the DSH Remote gateway.
 *
 * Every op is mapped to one exact `namespace.method` pair from `OP_TABLE`;
 * nothing else can be reached from the relay.
 */

import { ERROR, LOCAL_OPS, OP_TABLE, STREAM_OPS } from './protocol.js';

export class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}

/** Extract the session a request targets, when it names one. */
export function targetedSessionId(op, args = {}) {
  if (typeof args.sessionId === 'string') return args.sessionId;
  const address = args.address;
  if (address && typeof address === 'object') {
    if (typeof address.sessionId === 'string') return address.sessionId;
    if (typeof address.childSessionId === 'string') return address.childSessionId;
    if (typeof address.parentSessionId === 'string') return address.parentSessionId;
  }
  return undefined;
}

function mapGatewayError(error, signal) {
  if (error instanceof OpError) return error;
  if (signal?.aborted || error?.name === 'AbortError') {
    return new OpError(ERROR.CANCELLED, 'cancelled');
  }
  const code = typeof error?.code === 'string' && error.code ? error.code : undefined;
  const message = error?.message ? String(error.message) : String(error);
  return new OpError(ERROR.REMOTE_ERROR, code ? `${code}: ${message}` : message);
}

/**
 * Wrap a request object in the Remote's declared parameter name.
 *
 * The typert gateway validates argument keys against the descriptor and rejects
 * anything that does not match, so this must mirror DSH exactly. Methods with no
 * declared parameters receive an empty object.
 *
 * Some Remotes declare **several** wire parameters rather than one request
 * object — `userQuestions.answer` takes `agentId`, `callId` and `request`. Those
 * entries list their wire names in `wires`, and the caller supplies a map keyed
 * by wire name, which is passed through (reduced to the declared keys, so an
 * extra field cannot leak in).
 */
export function wireArgs(entry, args) {
  if (Array.isArray(entry.wires)) {
    const source = args ?? {};
    const out = {};
    for (const wire of entry.wires) {
      if (Object.prototype.hasOwnProperty.call(source, wire)) out[wire] = source[wire];
    }
    return out;
  }
  if (!entry.param) return {};
  return { [entry.param]: args ?? {} };
}

export function createOps({ gateway, config, log, harness = {} }) {
  const startedAt = Date.now();
  let gatewayFailureLogged = false;

  /**
   * How long to wait for the Workspace baseline before giving up on it.
   *
   * The frame is produced synchronously by the Host, so this only ever bites when
   * the gateway itself is wedged — and then a session list that arrives without
   * archived filtering beats one that never arrives.
   */
  const WORKSPACE_BASELINE_TIMEOUT_MS = 2_500;

  function sessionAllowed(sessionId) {
    const allow = config.allowedSessions ?? [];
    if (allow.length === 0) return true;
    if (!sessionId) return false;
    return allow.includes(String(sessionId));
  }

  function assertSessionAllowed(op, args) {
    const sessionId = targetedSessionId(op, args);
    if (sessionId !== undefined && !sessionAllowed(sessionId)) {
      throw new OpError(
        ERROR.SESSION_NOT_ALLOWED,
        `session ${sessionId} is not in allowedSessions for this desktop`,
      );
    }
  }

  function filterList(value) {
    const allow = config.allowedSessions ?? [];
    if (allow.length === 0 || !value || typeof value !== 'object') return value;
    if (!Array.isArray(value.items)) return value;
    return { ...value, items: value.items.filter((item) => sessionAllowed(item?.sessionId)) };
  }

  /**
   * The Sessions the desktop has archived.
   *
   * `session.list` hands them out like any other row, and the phone cannot tell:
   * the archived set lives in the Host's Workspace registry and is published only
   * as the **first frame** of `workspace.follow`
   * (`{type:'baseline', value:{items, archivedSessionIds, pinnedSessionIds}}`).
   * One frame is all this needs, so the stream is read once and closed again —
   * which also keeps archiving immediate, because there is no cache to go stale.
   *
   * Returns `null` whenever the set cannot be read (no streaming gateway, an
   * error, a timeout, a build without the Workspace feed). Every caller then
   * behaves exactly as it did before: show everything. An unavailable archived
   * list must not cost the phone its session list.
   *
   * @returns {Promise<Set<string>|null>} archived Session ids.
   */
  async function archivedSessionIds(signal) {
    if (!gateway || typeof gateway.stream !== 'function') return null;

    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forward, { once: true });
    }

    let timer = null;
    try {
      const iterable = await gateway.stream({
        namespace: 'workspace',
        method: 'follow',
        args: {},
        signal: controller.signal,
      });

      const read = (async () => {
        for await (const frame of iterable) {
          if (frame && frame.type === 'baseline') {
            const ids = frame.value?.archivedSessionIds ?? [];
            return new Set(ids.map(String));
          }
        }
        return null;
      })();
      // The race below may already have answered by the time this settles, so a
      // late rejection must not surface as an unhandled one.
      read.catch(() => {});

      // Racing rather than relying on the abort: a stream that ignores its signal
      // would otherwise hang `session.list`, and a phone waiting on a frozen
      // session list is a far worse failure than a list that shows archived rows.
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), WORKSPACE_BASELINE_TIMEOUT_MS);
      });
      return await Promise.race([read, timeout]);
    } catch (error) {
      log.debug(`workspace.follow baseline unavailable: ${error.message}`);
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
      // Leaving the loop already closes the DSH stream; aborting also covers the
      // path where the very first `await` is what we are unwinding from.
      controller.abort();
    }
  }

  /** Drops archived rows from a `session.list` value. */
  function withoutArchived(value, archived) {
    if (!archived || archived.size === 0) return value;
    if (!value || !Array.isArray(value.items)) return value;
    return {
      ...value,
      items: value.items.filter((item) => !archived.has(String(item?.sessionId ?? ''))),
    };
  }
  function localInfo() {
    return {
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      version: harness.version ?? null,
      platform: harness.platform ?? process.platform,
      node: process.version,
      uptimeMs: Date.now() - startedAt,
      gateway: Boolean(gateway),
      allowedSessions: config.allowedSessions ?? [],
      hideArchivedSessions: config.hideArchivedSessions !== false,
      reconnect: {
        autoConnect: config.autoConnect,
        reconnect: config.reconnect,
        heartbeatMs: config.heartbeatMs,
      },
    };
  }

  function noteGatewayFailure(error) {
    if (gatewayFailureLogged) return;
    gatewayFailureLogged = true;
    log.warn(
      `a Remote call failed (${error.message}). If this is a "not found" error, this DSH build ` +
        'does not expose the expected "session" Remote namespace; the bridge is otherwise inert.',
    );
  }

  async function run(op, args = {}, signal) {
    if (LOCAL_OPS.has(op)) return localInfo();

    const entry = OP_TABLE[op];
    if (!entry) throw new OpError(ERROR.OP_NOT_SUPPORTED, `op ${op} is not supported`);
    if (entry.stream || STREAM_OPS.has(op)) {
      throw new OpError(ERROR.BAD_ARGS, `op ${op} is streaming; use the stream path`);
    }
    if (!gateway) {
      throw new OpError(ERROR.GATEWAY_INTERNAL, 'the host gateway is unavailable in this composition');
    }
    assertSessionAllowed(op, args);

    // `includeArchived` belongs to this bridge, not to the Host. `session.list`
    // declares only `{cursor?}` and the gateway validates strictly, so our own key
    // is dropped before the request is wrapped. It exists so a verification — or a
    // human debugging by hand — can ask for the unfiltered list and prove the
    // archived filter removed something rather than that the list was short.
    // Nothing in the phone app sends it.
    const forwarded = { ...(args ?? {}) };
    const includeArchived = forwarded.includeArchived === true;
    delete forwarded.includeArchived;

    try {
      const value = await gateway.invoke({
        namespace: entry.namespace,
        method: entry.method,
        args: wireArgs(entry, forwarded),
        signal,
      });
      if (op !== 'session.list') return value;

      const listed = filterList(value);
      // Archived Sessions are a phone-side non-concept: the desktop keeps them
      // behind its own archive UI, and the phone has no way to restore one. Sent
      // as ordinary rows they were just noise in a list the phone scrolls with a
      // thumb — and they looked identical to live conversations.
      //
      // `includeArchived` turns off only the *removal*: the set is still read and
      // reported, so one call answers both "what is there" and "what is hidden" —
      // which is what makes the verification a comparison rather than a count.
      // Turning the feature off in config skips the read entirely.
      const archived =
          config.hideArchivedSessions === false ? null : await archivedSessionIds(signal);
      const filtered = includeArchived ? listed : withoutArchived(listed, archived);

      // A value that is not a list envelope (a Host that answered something else
      // entirely) is passed through as it came.
      if (!filtered || typeof filtered !== 'object' || Array.isArray(filtered)) return filtered;
      if (!archived) return filtered;
      // The set is reported whenever it could be read — **including when it is
      // empty**. That is what makes it a signal: a response without the field means
      // this build never looked, which is how a verification tells "the filter had
      // nothing to remove" apart from "the new code is not running yet".
      return { ...filtered, archivedSessionIds: [...archived].sort() };
    } catch (error) {
      const mapped = mapGatewayError(error, signal);
      if (mapped.code === ERROR.REMOTE_ERROR) noteGatewayFailure(mapped);
      throw mapped;
    }
  }

  async function openStream(op, args = {}, signal) {
    const entry = OP_TABLE[op];
    if (!entry || !entry.stream) {
      throw new OpError(ERROR.OP_NOT_SUPPORTED, `op ${op} is not a streaming op`);
    }
    if (!gateway) {
      throw new OpError(ERROR.GATEWAY_INTERNAL, 'the host gateway is unavailable in this composition');
    }
    assertSessionAllowed(op, args);

    try {
      const iterable = await gateway.stream({
        namespace: entry.namespace,
        method: entry.method,
        args: wireArgs(entry, args),
        signal,
      });
      return iterable;
    } catch (error) {
      throw mapGatewayError(error, signal);
    }
  }

  return { run, openStream, sessionAllowed, localInfo };
}
