// Opt-in file log for the bridge.
//
// Why this exists: the packaged DSH has no log directory, so `log.debug` from a
// plugin goes nowhere observable. That made an entire class of failure invisible
// — a waterfall handler that is never invoked looks exactly like one that is
// invoked and declines, and neither shows up anywhere.
//
// Off by default. Point `DSH_REMOTE_BRIDGE_DEBUG_LOG` (or the `debugLog` config
// key) at a file to turn it on.
import fs from 'node:fs';

export function createDebugLog({ path } = {}) {
  const target = typeof path === 'string' && path.length > 0 ? path : null;

  function write(line) {
    if (!target) return;
    try {
      fs.appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // A diagnostic that can break the bridge is worse than no diagnostic.
    }
  }

  return {
    enabled: Boolean(target),
    path: target,
    write,
    /** Log the fact that a handler ran, including why it decided not to act. */
    seen(what, detail) {
      write(`seen ${what}${detail ? ` ${detail}` : ''}`);
    },
    skip(what, reason) {
      write(`skip ${what}: ${reason}`);
    },
    send(what, detail) {
      write(`send ${what}${detail ? ` ${detail}` : ''}`);
    },
    fail(what, error) {
      write(`fail ${what}: ${error?.message ?? error}`);
    },
  };
}
