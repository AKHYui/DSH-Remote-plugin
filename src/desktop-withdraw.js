/**
 * Withdraw a desktop prompt whose request the phone already answered.
 *
 * Both surfaces are offered the *same* waterfall request: this plugin prepends to
 * `approval/request` and `user-questions/request`, offers the ask to the phone,
 * and passes the request straight on with `next()` so DSH's built-in forwarder
 * can show the desktop window. Whichever side submits first wins — and the loser
 * is left waiting forever, because nothing tells it the request is over.
 *
 * The host side of that forwarding lives in `@deepseek-ai/dsh-api-gateway`. Every
 * forwarded waterfall is one `pending` record in the gateway service, and
 * `finishRemoteEvent(pending)` is what pushes the `{type:'cancel', eventId}`
 * frame that makes the client withdraw its prompt:
 *
 *   - `dsh-api-gateway/lib/index.js:937-948` — `finishRemoteEvent` sends the
 *     cancel frame to every client the event was delivered to.
 *   - `dsh-api-gateway/lib/client.js:809-810` — the cancel frame aborts the
 *     per-event `AbortController`.
 *   - `dsh-client-ui-approval/lib/client.js:196-201` — that signal's `abort`
 *     event calls `PendingApproval.abort()`, which settles the prompt.
 *
 * Nothing in DSH publishes an API for this, so **every step is feature-detected**
 * and the failure mode is exactly today's behaviour: the prompt stays open and a
 * debug line says why. The failure is never worse than not doing this at all.
 *
 * Matching is by object identity: the request this plugin's waterfall handler
 * receives *is* `pending.source.request`, the same reference the forwarder was
 * given. A looser match (event + agent + callId) is kept as a fallback in case a
 * future build clones the request.
 */

import { createDebugLog } from './debug-log.js';

/** How the gateway records one forwarded waterfall; only the fields we read. */
function pendingOf(gateway) {
  const table = gateway?.pendingRemoteEvents;
  return table instanceof Map ? table : null;
}

export function createDesktopWithdraw({
  gateway,
  debug = createDebugLog(),
  timers = { setTimeout, clearTimeout },
  attempts = 5,
  retryMs = 60,
} = {}) {
  const retries = new Set();
  let announced = false;
  let unavailableReported = false;

  function service() {
    try {
      const value = typeof gateway === 'function' ? gateway() : gateway;
      return value ?? null;
    } catch {
      return null;
    }
  }

  function find(gatewayService, request, event) {
    const table = pendingOf(gatewayService);
    if (table === null || table.size === 0) return null;

    const agentId = String(request?.agent?.id ?? '');
    const callId = request?.callId ?? null;
    let loose = null;
    let candidates = 0;

    for (const pending of table.values()) {
      const frame = pending?.frame;
      if (!frame || frame.event !== event) continue;
      if (pending.source?.request === request) return pending;
      if (
        agentId !== '' &&
        frame.agentId === agentId &&
        (callId === null || frame.request?.callId === callId)
      ) {
        loose = pending;
        candidates += 1;
      }
    }
    // An ambiguous fallback is not worth guessing at: cancelling the wrong
    // prompt is worse than leaving the right one up.
    return candidates === 1 ? loose : null;
  }

  function finish(gatewayService, pending) {
    // Only touch a record that is still registered: finishing one twice would
    // push a second cancel frame for an id the client already dropped.
    if (pendingOf(gatewayService)?.get(pending?.id) !== pending) return false;
    if (typeof gatewayService.finishRemoteEvent === 'function') {
      gatewayService.finishRemoteEvent(pending);
      return true;
    }
    if (typeof gatewayService.cancelRemoteEvent === 'function') {
      gatewayService.cancelRemoteEvent(
        pending,
        new Error('dsh-remote-bridge: the phone answered this request'),
      );
      return true;
    }
    return false;
  }

  function attempt(request, event) {
    const gatewayService = service();
    if (gatewayService === null) return false;
    const pending = find(gatewayService, request, event);
    if (pending === null) return false;
    try {
      return finish(gatewayService, pending);
    } catch (error) {
      debug.fail('desktop withdraw', error);
      return false;
    }
  }

  /**
   * Ask the host to withdraw the desktop's prompt for this request.
   *
   * Fire-and-forget: the waterfall must not wait on cosmetic cleanup.
   *
   * @param request - the exact request object the waterfall handler received.
   * @param event - `approval/request` or `user-questions/request`.
   * @returns whether a pending forwarded event was finished immediately.
   */
  function withdraw(request, event) {
    // No readable pending table means either the service is absent or this build
    // keeps forwarded events somewhere this module does not understand. Waiting
    // cannot change either, so report it once and leave the prompt alone.
    if (pendingOf(service()) === null) {
      if (!unavailableReported) {
        unavailableReported = true;
        debug.write(
          'desktop prompts cannot be withdrawn: this DSH build exposes no gateway pending-event table',
        );
      }
      return false;
    }
    if (attempt(request, event)) {
      if (!announced) {
        announced = true;
        debug.write(`desktop prompt withdrawn (${event})`);
      }
      return true;
    }

    // A phone on a warm connection can answer before the forwarder's dispatch
    // has been drained into a pending record — `next()` only queues it. Retry
    // briefly instead of giving up on a race we would otherwise always lose.
    let remaining = attempts;
    const tick = () => {
      retries.delete(id);
      if (attempt(request, event)) {
        if (!announced) {
          announced = true;
          debug.write(`desktop prompt withdrawn after a retry (${event})`);
        }
        return;
      }
      remaining -= 1;
      if (remaining > 0) schedule();
    };
    const schedule = () => {
      id = timers.setTimeout(tick, retryMs);
      retries.add(id);
    };
    let id = null;
    schedule();
    return false;
  }

  function dispose() {
    for (const id of retries) timers.clearTimeout(id);
    retries.clear();
  }

  /**
   * What the gateway looks like from here, for the debug log.
   *
   * This one line is what tells the difference between "the withdrawal ran and
   * the prompt still stayed" and "this build keeps its forwarded events somewhere
   * else", without needing a live approval to find out.
   */
  function status() {
    const gatewayService = service();
    const table = pendingOf(gatewayService);
    return {
      gateway: gatewayService !== null,
      pendingTable: table === null ? null : table.size,
      finishRemoteEvent: typeof gatewayService?.finishRemoteEvent === 'function',
      cancelRemoteEvent: typeof gatewayService?.cancelRemoteEvent === 'function',
    };
  }

  return { withdraw, dispose, status };
}
