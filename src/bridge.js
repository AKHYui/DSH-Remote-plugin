/**
 * The bridge: binds the transport, the op table, the event fan-out and the
 * approval waterfalls into one disposable unit.
 *
 * `createBridge` only needs a `ctx` with `typertGateway` and `on`, so it runs
 * unchanged inside DSH, inside the simulator, and inside tests.
 */

import { createApprovals } from './approvals.js';
import { createDebugLog } from './debug-log.js';
import { createDesktopWithdraw } from './desktop-withdraw.js';
import { createEvents } from './events.js';
import { createLink } from './link.js';
import { createOps, OpError } from './ops.js';
import {
  ALL_CAPABILITIES,
  ALLOWED_OPS,
  ERROR,
  STREAM_OPS,
  TOPIC,
  errorFrame,
  evtFrame,
  okFrame,
  streamFrame,
} from './protocol.js';

export function createBridge({
  ctx,
  config,
  log,
  platform = process.platform,
  harness = {},
  WebSocketImpl = globalThis.WebSocket,
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
}) {
  const startedAt = now();
  const inflight = new Map();

  const link = createLink({
    config,
    log,
    platform,
    harness,
    capabilities: ALL_CAPABILITIES,
    WebSocketImpl,
    timers,
    now,
  });

  const ops = createOps({ gateway: ctx?.typertGateway, config, log, harness });

  const events = createEvents({ log });
  const debug = createDebugLog({ path: config.debugLog });
  debug.write(
    `bridge init deviceId=${config.deviceId || '(unset)'} debugLog=${debug.path ?? '(off)'}`,
  );
  const approvals = createApprovals({
    log,
    timeoutMs: config.approvalTimeoutMs,
    timers,
    now,
    debug,
  });

  const emitEvent = async (topic, payload) => {
    link.send(evtFrame(topic, payload));
  };
  events.setSender(emitEvent);
  approvals.setSender(emitEvent);
  approvals.setReady(() => link.ready);
  approvals.setSessionAllowed(ops.sessionAllowed);

  // The desktop's own prompt is driven by DSH's forwarded waterfall, which nothing
  // answers once the phone wins — so it has to be taken down from the host side.
  // Resolved lazily: the service must be looked up when a race is won, not at
  // load time, so a composition that provides it later still works.
  const desktopWithdraw = createDesktopWithdraw({
    gateway: () => ctx?.typertGateway,
    debug,
    timers,
  });
  approvals.setDesktopWithdraw(desktopWithdraw.withdraw);

  const disposers = [];

  async function handleRequest(frame) {
    const { id, op } = frame;
    const args = frame.args && typeof frame.args === 'object' ? frame.args : {};

    if (typeof op !== 'string' || !ALLOWED_OPS.has(op)) {
      link.trySend(errorFrame(id, ERROR.OP_NOT_SUPPORTED, `op ${op} is not supported by this bridge`));
      return;
    }

    const controller = new AbortController();
    inflight.set(id, controller);

    if (STREAM_OPS.has(op)) {
      try {
        const iterable = await ops.openStream(op, args, controller.signal);
        link.trySend(streamFrame(id, 'open'));
        for await (const chunk of iterable) {
          if (controller.signal.aborted) break;
          if (!link.trySend(streamFrame(id, 'chunk', { value: chunk }))) break;
        }
        link.trySend(streamFrame(id, 'end'));
      } catch (error) {
        link.trySend(
          streamFrame(id, 'error', {
            error: {
              code: error instanceof OpError ? error.code : ERROR.GATEWAY_INTERNAL,
              message: error?.message ? String(error.message) : String(error),
            },
          }),
        );
      } finally {
        inflight.delete(id);
      }
      return;
    }

    try {
      const value = await ops.run(op, args, controller.signal);
      link.trySend(okFrame(id, value));
    } catch (error) {
      link.trySend(
        errorFrame(
          id,
          error instanceof OpError ? error.code : ERROR.GATEWAY_INTERNAL,
          error?.message ? String(error.message) : String(error),
        ),
      );
    } finally {
      inflight.delete(id);
    }
  }

  /**
   * Frame dispatch must never await: a long `session.prompt` would otherwise
   * block the socket reader and delay `cancel` and `approval` frames.
   */
  function dispatch(frame) {
    switch (frame.t) {
      case 'ping':
        link.trySend({ t: 'pong', id: frame.id });
        return;
      case 'req':
        void handleRequest(frame);
        return;
      case 'cancel': {
        const controller = inflight.get(frame.id);
        if (controller) {
          controller.abort();
          inflight.delete(frame.id);
        }
        return;
      }
      case 'sub':
        events.subscribe(frame.id, frame.topics, frame.args);
        return;
      case 'unsub':
        events.unsubscribe(frame.id);
        return;
      case 'approval':
        approvals.resolve(frame);
        return;
      default:
        log.debug(`ignoring unexpected frame type ${frame.t}`);
    }
  }

  disposers.push(link.on('frame', dispatch));
  disposers.push(
    link.on('down', () => {
      // Subscriptions live on the relay; it re-sends `sub` after a reconnect.
      events.clear();
      approvals.cancelAll('link down');
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    }),
  );

  let attached = false;
  function start() {
    if (!attached) {
      attached = true;
      debug.write('start(): attaching waterfalls');
      debug.write(`desktop withdraw: ${JSON.stringify(desktopWithdraw.status())}`);
      disposers.push(events.attach(ctx));
      disposers.push(approvals.attach(ctx));
    }
    // `autoConnect: false` loads the plugin without dialing: no socket, no traffic,
    // nothing exposed — but the waterfalls and the op table are ready, so the switch
    // is a config edit away. It was documented for a long time before it did
    // anything; now the documented behaviour is the real one.
    if (config.autoConnect === false) {
      log.info('autoConnect is off: loaded, but not dialing the relay');
      return;
    }
    link.start();
  }

  function stop(reason) {
    link.stop(reason);
    approvals.cancelAll(reason ?? 'bridge stopped');
    desktopWithdraw.dispose();
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        log.debug(`disposer failed: ${error.message}`);
      }
    }
    attached = false;
  }

  return {
    start,
    stop,
    dispatch,
    link,
    ops,
    events,
    approvals,
    status() {
      return {
        startedAt,
        link: link.status(),
        events: events.stats(),
        approvals: approvals.stats(),
        inflight: inflight.size,
      };
    },
  };
}

export { TOPIC };
