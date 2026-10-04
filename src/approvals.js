/**
 * Approval bridging.
 *
 * DSH dispatches `approval/request` and `user-questions/request` as waterfalls:
 * a listener that returns an outcome claims the request, and one that calls
 * `next()` delegates. This module forwards the ask to a paired phone and, on
 * timeout, cancellation, link loss or any error, **delegates to the desktop**.
 *
 * There is deliberately no auto-approve path.
 */

import { TOPIC, newId } from './protocol.js';
import { createDebugLog } from './debug-log.js';

export function createApprovals({
  log,
  timeoutMs,
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
  debug = createDebugLog(),
}) {
  const pending = new Map();
  const stats = { asked: 0, answered: 0, timedOut: 0, cancelled: 0, linkLost: 0, deferred: 0 };
  let sender = null;
  let ready = () => false;
  let sessionAllowed = () => true;
  // Injected by the bridge; withdraws the desktop's prompt when the phone wins.
  let withdrawDesktop = null;

  function setSender(fn) {
    sender = fn;
  }

  function setReady(fn) {
    ready = fn;
  }

  function setSessionAllowed(fn) {
    sessionAllowed = fn;
  }

  function setDesktopWithdraw(fn) {
    withdrawDesktop = typeof fn === 'function' ? fn : null;
  }

  function settleAsk(askId, value, by) {
    const entry = pending.get(askId);
    if (!entry) return false;
    pending.delete(askId);
    if (entry.timer) timers.clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.by = by;
    entry.settle(value);
    return true;
  }

  /** Called by the bridge when the relay forwards a phone decision. */
  function resolve(frame) {
    if (typeof frame?.askId !== 'string') return false;
    return settleAsk(frame.askId, frame, 'phone');
  }

  /** Release every pending ask, e.g. when the link drops. */
  function cancelAll(reason = 'link lost') {
    const ids = [...pending.keys()];
    for (const askId of ids) settleAsk(askId, null, 'desktop');
    if (ids.length > 0) log.debug(`released ${ids.length} pending ask(s): ${reason}`);
    return ids.length;
  }

  function ask({ topic, body, signal }) {
    if (!sender || !ready()) {
      debug.skip(topic, `sender=${Boolean(sender)} ready=${ready()}`);
      return Promise.resolve(null);
    }
    debug.send(topic, `ask for session=${body?.sessionId ?? '?'}`);

    const askId = newId('ask');
    const deadline = now() + timeoutMs;
    const entry = {
      by: 'timeout',
      settle: () => {},
      timer: null,
      signal: null,
      onAbort: null,
      sent: false,
    };

    const decision = new Promise((settle) => {
      entry.settle = settle;
      entry.timer = timers.setTimeout(() => settleAsk(askId, null, 'timeout'), timeoutMs);
      // Register before wiring the abort listener: an already-aborted signal
      // settles synchronously, and `settleAsk` must find the entry.
      pending.set(askId, entry);
      if (signal) {
        entry.signal = signal;
        entry.onAbort = () => settleAsk(askId, null, 'cancelled');
        if (signal.aborted) entry.onAbort();
        else signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      Promise.resolve()
        .then(() => {
          // An ask that settled before it was sent must never reach the phone.
          if (!pending.has(askId)) return undefined;
          entry.sent = true;
          stats.asked += 1;
          return sender(topic, { ...body, askId, deadline });
        })
        .catch((error) => {
          log.debug(`could not reach the phone for ${askId}: ${error.message}`);
          settleAsk(askId, null, 'link_lost');
        });
    });

    return decision.then((value) => {
      if (value === null) {
        stats.deferred += 1;
        if (entry.by === 'timeout') stats.timedOut += 1;
        else if (entry.by === 'cancelled') stats.cancelled += 1;
        else if (entry.by === 'link_lost') stats.linkLost += 1;
      } else {
        stats.answered += 1;
      }
      if (entry.sent) {
        const by = value === null ? entry.by : 'phone';
        void Promise.resolve(sender(TOPIC.APPROVAL_SETTLED, { askId, by })).catch(() => {});
      }
      return value;
    });
  }

  const APPROVAL_OUTCOME = {
    approved: 'allowed-once',
    denied: 'rejected',
    cancelled: 'cancelled',
  };

  /**
   * Bind both waterfalls. Every path that is not a clean phone answer calls
   * `next()`, so the desktop's own answerers always remain the fallback.
   */
  function attach(ctx) {
    const disposers = [];
    const bind = (target, name, handler, options) => {
      try {
        const off = target.on(name, handler, options);
        if (typeof off === 'function') disposers.push(off);
        debug.write(
          `joined ${name} (disposer=${typeof off === 'function'}${options?.prepend ? ' prepend' : ''})`,
        );
      } catch (error) {
        debug.fail(`join ${name}`, error);
        log.warn(`could not join the ${name} waterfall: ${error.message}`);
      }
    };

    /**
     * Offer the ask on the phone *and* let the desktop prompt for it, then take
     * whichever is submitted first — the WorkBuddy behaviour.
     *
     * `prepend` is what makes this possible at all: the built-in forwarder claims
     * a waterfall and never calls `next()`, so without claiming first the phone
     * would never be offered the ask. But claiming alone would suppress the
     * desktop, so the request is passed straight on through `next()` and the two
     * answers race. Whenever the phone's answer is missing or unusable, the
     * desktop's result is used — so the desktop remains the fallback.
     *
     * When the phone wins, the desktop's prompt has to be taken down explicitly:
     * it is waiting on *its own* request, which nothing will ever answer now.
     */
    async function raceWithDesktop({
      topic,
      event,
      request,
      body,
      signal,
      next,
      usable,
      desktopUsable,
    }) {
      const desktopSettled = Promise.resolve()
        .then(() => next())
        .then(
          (value) => ({ from: 'desktop', value }),
          () => ({ from: 'desktop', value: undefined }),
        );
      // Only a real submission counts, and an unusable desktop result must not
      // settle the race: `Promise.race` takes the first promise to SETTLE, so an
      // immediate "unavailable" from `next()` would otherwise beat a phone answer
      // that is merely slower. Leaving that branch pending keeps the phone in the
      // running; the desktop's raw value is still used as the final fallback.
      const desktopAnswered = desktopSettled.then((result) =>
        desktopUsable(result.value) ? result : new Promise(() => {}),
      );
      const phoneAnswered = ask({ topic, body, signal }).then(
        (value) => (usable(value) ? { from: 'phone', value } : null),
        () => null,
      );
      const first = await Promise.race([phoneAnswered, desktopAnswered]);
      // Which surface actually won decides where to look when an answer "does
      // not arrive": if the desktop wins, the phone's submission was discarded.
      debug.write(`race: won by ${first ? first.from : 'nobody (desktop fallback)'}`);
      if (first?.from === 'phone' && withdrawDesktop !== null) {
        try {
          withdrawDesktop(request, event);
        } catch (error) {
          debug.fail('desktop withdraw', error);
        }
      }
      return first ?? (await desktopSettled);
    }

    async function approvalHandler(req, next) {
      debug.seen('approval/request', `session=${req?.agent?.id ?? ''} tool=${req?.toolName ?? ''}`);
      try {
        const sessionId = String(req?.agent?.id ?? '');
        if (!ready() || !sessionAllowed(sessionId)) {
          debug.skip('approval/request', `ready=${ready()} allowed=${sessionAllowed(sessionId)}`);
          return await next();
        }

        const outcome = await raceWithDesktop({
          topic: TOPIC.APPROVAL_ASK,
          event: 'approval/request',
          request: req,
          signal: req?.signal,
          next,
          usable: (decision) => Boolean(decision && APPROVAL_OUTCOME[decision.decision]),
          // 'unavailable' means nobody answered on the desktop — not a decision.
          desktopUsable: (value) => value === 'allowed-once' || value === 'rejected',
          body: {
            sessionId,
            toolName: req?.toolName ?? null,
            callId: req?.callId ?? null,
            reason: req?.reason ?? null,
            displayReason: req?.displayReason ?? null,
          },
        });
        if (outcome.from === 'desktop') return outcome.value;
        return APPROVAL_OUTCOME[outcome.value.decision];
      } catch (error) {
        log.warn(`approval bridge failed, deferring to the desktop: ${error.message}`);
        return await next();
      }
    }

    async function questionHandler(request, next) {
      debug.seen('user-questions/request', `session=${request?.agent?.id ?? ''}`);
      try {
        const sessionId = String(request?.agent?.id ?? '');
        if (!ready() || !sessionAllowed(sessionId)) {
          debug.skip('user-questions/request', `ready=${ready()} allowed=${sessionAllowed(sessionId)}`);
          return await next();
        }

        const outcome = await raceWithDesktop({
          topic: TOPIC.QUESTION_ASK,
          event: 'user-questions/request',
          request,
          signal: request?.signal,
          next,
          usable: (decision) => Boolean(decision && decision.decision !== 'cancelled'),
          desktopUsable: (value) => Boolean(value && Array.isArray(value.answers)),
          body: {
            sessionId,
            questions: request?.questions ?? [],
            wait: request?.wait ?? null,
          },
        });
        if (outcome.from === 'desktop') return outcome.value;
        return { answers: Array.isArray(outcome.value.answers) ? outcome.value.answers : [] };
      } catch (error) {
        log.warn(`question bridge failed, deferring to the desktop: ${error.message}`);
        return await next();
      }
    }

    // Bound ONCE, on the plugin's own context.
    //
    // An earlier version also bound on `ctx.root` and per-agent on `agent.ctx`,
    // on the theory that scope visibility was hiding these events. That theory
    // was wrong: Cordis keeps a single global hook table — `EventsService` is
    // created only on the root context and `extend()` is prototype inheritance —
    // so every `ctx.on` anywhere appends to the same list, and the scope filter
    // admits unscoped contexts. Three bindings therefore meant up to three copies
    // of the same ask reaching the phone.
    bind(ctx, 'approval/request', approvalHandler, { prepend: true });
    bind(ctx, 'user-questions/request', questionHandler, { prepend: true });

    // There is deliberately no second registration anywhere — not on `ctx.root`,
    // not per-agent, and not on another plugin's context. It would not be dead
    // weight: it would fire, because all of them share one hook table.

    // The per-agent scope is tracked only so the debug log can show the agent
    // lifecycle; nothing is registered on it.
    const perAgent = new Map();

    function attachAgent(agent) {
      const id = String(agent?.id ?? '');
      const scoped = agent?.ctx;
      if (!id || !scoped || typeof scoped.on !== 'function') {
        debug.fail('agent/created', `no scoped ctx for agent ${id || '(none)'}`);
        return;
      }
      if (perAgent.has(id)) return;
      perAgent.set(id, []);
      debug.write(`agent scope known: ${id}`);
    }

    function detachAgent(agent) {
      const id = String(agent?.id ?? '');
      const offs = perAgent.get(id);
      if (!offs) return;
      perAgent.delete(id);
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      debug.write(`left agent scope ${id}`);
    }

    const onAgentCreated = (payload) => {
      debug.seen('agent/created', `agent=${payload?.agent?.id ?? ''}`);
      attachAgent(payload?.agent);
    };
    const onAgentDisposed = (payload) => detachAgent(payload?.agent);

    // `agent/created` is the documented way in to a live agent, so it is bound —
    // ONCE, on the plugin's own context. An earlier version bound it on the root as
    // well "to see which one fires"; because there is a single global hook table,
    // both fired, and the debug log dutifully printed every `seen agent/created`
    // line twice. The same mistake in this file is what once sent each ask to the
    // phone up to three times.
    bind(ctx, 'agent/created', onAgentCreated);
    bind(ctx, 'agent/disposed', onAgentDisposed);

    return () => {
      cancelAll('plugin shutdown');
      for (const offs of perAgent.values()) {
        for (const off of offs) {
          try {
            off();
          } catch {
            /* ignore */
          }
        }
      }
      perAgent.clear();
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
    ask,
    setSender,
    setReady,
    setSessionAllowed,
    setDesktopWithdraw,
    resolve,
    cancelAll,
    stats: () => ({ ...stats, pending: pending.size }),
  };
}
