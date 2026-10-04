/**
 * Session event fan-out.
 *
 * The relay registers a subscription per phone; this module decides whether an
 * event is wanted by anyone at all, then hands it to the link. Delivery is
 * queued so a slow socket cannot block the DSH event dispatch path.
 */

import { KNOWN_TOPICS, TOPIC } from './protocol.js';

export function createEvents({ log, maxQueue = 1_000 }) {
  const subscriptions = new Map();
  let sender = null;
  const queue = [];
  let draining = false;
  let dropped = 0;
  let delivered = 0;

  function setSender(fn) {
    sender = fn;
  }

  function subscribe(id, topics, args = {}) {
    const unknown = (topics ?? []).filter((topic) => !KNOWN_TOPICS.has(topic));
    if (unknown.length > 0) {
      log.warn(`ignoring subscription ${id} with unknown topics: ${unknown.join(', ')}`);
      return false;
    }
    if (!topics || topics.length === 0) {
      log.warn(`ignoring subscription ${id} with no topics`);
      return false;
    }
    subscriptions.set(id, { id, topics: new Set(topics), args: args ?? {} });
    return true;
  }

  function unsubscribe(id) {
    return subscriptions.delete(id);
  }

  function clear() {
    subscriptions.clear();
  }

  function sessionFilterPasses(sub, payload) {
    const ids = sub.args?.sessionIds;
    if (!Array.isArray(ids) || ids.length === 0) return true;
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return true; // cannot tell → forward
    return ids.includes(sessionId);
  }

  function wanted(topic, payload) {
    for (const sub of subscriptions.values()) {
      if (!sub.topics.has(topic)) continue;
      if (sessionFilterPasses(sub, payload)) return true;
    }
    return false;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await sender(item.topic, item.payload);
          delivered += 1;
        } catch {
          // The link is gone. Drop the backlog; the relay re-subscribes on
          // reconnect and `session.follow` recovers by cursor.
          queue.length = 0;
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  function publish(topic, payload) {
    if (!sender) return;
    if (!wanted(topic, payload)) return;
    if (queue.length >= maxQueue) {
      dropped += 1;
      return;
    }
    queue.push({ topic, payload });
    void drain();
  }

  /**
   * Bind the DSH event surface. Returns a disposer.
   *
   * Every handler is defensive: an exception here would otherwise surface inside
   * the DSH append path.
   */
  function attach(ctx) {
    const disposers = [];

    // Bound ONCE, on the plugin's own context.
    //
    // An earlier version also bound on `ctx.root`, on the theory that these events
    // are dispatched from scoped contexts and that only an ancestor's listener is on
    // the path. That theory is wrong: Cordis keeps **one** global hook table
    // (`EventsService` exists only on the root and `extend()` is prototype
    // inheritance), and the scope filter admits unscoped listener contexts. Binding
    // both places delivered every event to the relay **twice** — and nobody noticed
    // because the phone dedupes `session.event` by seq, which is a client-side
    // requirement, not a licence to send it twice.
    const bind = (name, handler) => {
      try {
        const off = ctx.on(name, handler);
        if (typeof off === 'function') disposers.push(off);
      } catch (error) {
        log.warn(`could not subscribe to ${name}: ${error.message}`);
      }
    };

    bind('session/event', (session, event) => {
      try {
        const sessionId = String(session?.id ?? event?.data?.sessionId ?? '');
        publish(TOPIC.SESSION_EVENT, {
          sessionId,
          seq: event?.seq ?? null,
          type: event?.type ?? null,
          time: event?.time ?? null,
          data: event?.data ?? null,
          surfaceOp: event?.surfaceOp ?? null,
          sourceEventSeqs: event?.sourceEventSeqs ?? null,
        });
      } catch (error) {
        log.debug(`session/event handler failed: ${error.message}`);
      }
    });

    bind('agent/status', (payload) => {
      try {
        publish(TOPIC.SESSION_STATUS, {
          sessionId: String(payload?.agent?.id ?? ''),
          status: payload?.status ?? null,
        });
      } catch (error) {
        log.debug(`agent/status handler failed: ${error.message}`);
      }
    });

    bind('api-session/added', (summary) => {
      publish(TOPIC.SESSION_ACTIVITY, {
        kind: 'added',
        sessionId: String(summary?.sessionId ?? ''),
        running: Boolean(summary?.running),
        updatedAt: summary?.updatedAt ?? null,
      });
    });

    bind('api-session/removed', (sessionId) => {
      publish(TOPIC.SESSION_ACTIVITY, { kind: 'removed', sessionId: String(sessionId ?? '') });
    });

    bind('api-session/activity', (sessionId, updatedAt) => {
      publish(TOPIC.SESSION_ACTIVITY, {
        kind: 'activity',
        sessionId: String(sessionId ?? ''),
        updatedAt: updatedAt ?? null,
      });
    });

    return () => {
      for (const off of disposers) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    };
  }

  return {
    attach,
    setSender,
    subscribe,
    unsubscribe,
    clear,
    publish,
    stats: () => ({ subscriptions: subscriptions.size, queued: queue.length, dropped, delivered }),
  };
}
