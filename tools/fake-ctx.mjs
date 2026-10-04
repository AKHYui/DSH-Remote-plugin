/**
 * A minimal stand-in for the Cordis context a DSH plugin receives.
 *
 * Used by the unit tests and by `tools/simulate.mjs` so the bridge can run
 * without a live DeepSeek Harness. It implements exactly the surface the plugin
 * touches: `typertGateway`, `on`, and `effect`.
 */

function gatewayError(message, code = 'gateway/not-found') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createFakeCtx({ ops = {}, streams = {}, withRoot = false } = {}) {
  const listeners = new Map();
  const listenerOptions = new Map();
  const calls = [];
  const disposers = [];

  // One registration path, shared by the context and (when `withRoot`) by its
  // root — mirroring Cordis, where `EventsService` exists only on the root and
  // `extend()` is prototype inheritance, so *every* `ctx.on` anywhere lands in the
  // same table. Without this a plugin that binds the same event twice looks
  // correct in tests while the real host delivers it twice.
  const register = (name, handler, options) => {
    const list = listeners.get(name) ?? [];
    // `prepend` is load-bearing, not cosmetic: a waterfall hands `next` only to
    // its first listener, so a listener that is not first can be unreachable
    // forever.
    if (options?.prepend) list.unshift(handler);
    else list.push(handler);
    listeners.set(name, list);
    if (options) listenerOptions.set(handler, options);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };

  const ctx = {
    typertGateway: {
      async invoke(request) {
        calls.push({ kind: 'invoke', ...request });
        const handler = ops[`${request.namespace}.${request.method}`];
        if (!handler) {
          throw gatewayError(`no Remote ${request.namespace}.${request.method}`);
        }
        return handler(request.args ?? {}, request);
      },
      async stream(request) {
        calls.push({ kind: 'stream', ...request });
        const handler = streams[`${request.namespace}.${request.method}`];
        if (!handler) {
          throw gatewayError(`no streaming Remote ${request.namespace}.${request.method}`);
        }
        return handler(request.args ?? {}, request);
      },
    },

    on: register,

    effect(setup) {
      const dispose = setup();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  // `withRoot` reproduces the real composition. A root context shares the same
  // registration path, so an event bound on both really does fire twice.
  let root = null;
  if (withRoot) {
    root = { ...ctx };
    root.root = root;
    ctx.root = root;
  }

  return {
    ctx,
    root,
    calls,

    /** Fire every handler registered for a DSH event. */
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },

    listener(name) {
      const list = listeners.get(name) ?? [];
      if (list.length === 0) throw new Error(`no listener registered for ${name}`);
      return list[list.length - 1];
    },

    listenerCount(name) {
      return (listeners.get(name) ?? []).length;
    },

    /** The options a listener was registered with, if any. */
    optionsFor(handler) {
      return listenerOptions.get(handler) ?? null;
    },

    eventNames() {
      return [...listeners.keys()];
    },

    settledCalls(prefix) {
      return calls.filter((call) => `${call.namespace}.${call.method}` === prefix);
    },

    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * A WHATWG-WebSocket look-alike that records what the plugin sent.
 *
 * The bridge only ever calls `send`/`close` and assigns the four `on*` handlers,
 * so this is enough to drive the whole transport from a test.
 */
export class FakeWebSocket {
  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closeCalls = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  // -- client surface ------------------------------------------------------

  send(data) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // -- test drivers --------------------------------------------------------

  /** Complete the handshake. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver one relay frame to the plugin. */
  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Deliver a raw (possibly malformed) payload. */
  deliverRaw(data) {
    this.onmessage?.({ data });
  }

  /** The relay dropped the socket with the given close code. */
  serverClose(code = 1000, reason = '') {
    this.readyState = 3;
    const handler = this.onclose;
    this.onclose = null;
    handler?.({ code, reason });
  }

  framesOfType(type) {
    return this.sent.filter((frame) => frame.t === type);
  }

  lastFrame() {
    return this.sent[this.sent.length - 1];
  }

  framesFor(id) {
    return this.sent.filter((frame) => frame.id === id);
  }
}

/** Deterministic timer queue, so heartbeat and backoff are testable. */
export function createFakeTimers() {
  let nextId = 0;
  const pending = new Map();

  return {
    setTimeout(fn, ms) {
      const id = ++nextId;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Run the earliest scheduled callback; returns its delay or null. */
    runNext() {
      const entry = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms)[0];
      if (!entry) return null;
      pending.delete(entry[0]);
      entry[1].fn();
      return entry[1].ms;
    },
    runAll(limit = 100) {
      const delays = [];
      for (let i = 0; i < limit; i += 1) {
        const delay = this.runNext();
        if (delay === null) break;
        delays.push(delay);
      }
      return delays;
    },
    pendingCount() {
      return pending.size;
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
  };
}

/** Flush pending microtasks (and one macrotask) so awaited work settles. */
export function flush(times = 3) {
  return new Promise((resolve) => {
    let remaining = times;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });
}
