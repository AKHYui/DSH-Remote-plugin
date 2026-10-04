/**
 * DSH plugin entry.
 *
 * Configuration arrives from the profile patch row (`apply(ctx, config)`) and
 * may be overridden per key by `DSH_REMOTE_BRIDGE_*` environment variables —
 * see `src/config.js`. The environment path is the reliable one for the
 * connector token, which is a secret.
 */

import { createBridge } from './bridge.js';
import { resolveConfig } from './config.js';
import { createLogger } from './log.js';
import { PROTOCOL_VERSION, evtFrame } from './protocol.js';

export const name = 'dsh-remote-bridge';

/**
 * Hard dependency: every op is dispatched through the Remote gateway. If this
 * DSH build does not provide it, the plugin stays inert rather than throwing
 * during tree construction.
 */
export const inject = ['typertGateway'];

export const CONFIG_SOURCES = 'profile patch row or DSH_REMOTE_BRIDGE_* environment variables';

export function apply(ctx, rawConfig = {}) {
  const { config, problems, fatal, sources } = resolveConfig(rawConfig, process.env);
  const log = createLogger(config.logLevel);

  for (const problem of problems) {
    if (problem.startsWith('WARNING:')) log.warn(problem.slice('WARNING:'.length).trim());
    else log.error(problem);
  }

  if (fatal.length > 0) {
    log.error(
      `not starting: ${fatal.length} configuration problem(s) above. ` +
        `Set them in the ${CONFIG_SOURCES}.`,
    );
    return () => {};
  }

  const from = Object.entries(sources)
    .map(([key, origin]) => `${key}<-${origin}`)
    .join(' ');
  log.info(
    `starting (protocol v${PROTOCOL_VERSION}) deviceId=${config.deviceId} server=${config.serverUrl}` +
      (from ? ` [${from}]` : ' [defaults]'),
  );
  if ((config.allowedSessions ?? []).length > 0) {
    log.info(`restricted to ${config.allowedSessions.length} session(s): ${config.allowedSessions.join(', ')}`);
  }

  const bridge = createBridge({
    ctx,
    config,
    log,
    platform: process.platform,
    // `version` here is the **plugin's** version, not the harness's: the packaged
    // app's version lives inside `app.asar` and is not visible from a plugin. The
    // wire field is called `harness.version` (hello frame + `harness.info`) for
    // historical reasons; docs/PROTOCOL.md says what it actually is.
    harness: { version: '0.1.0', node: process.version, gateway: Boolean(ctx?.typertGateway) },
  });

  bridge.start();

  let stopped = false;
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    log.info(`stopping (${reason})`);
    try {
      bridge.stop(reason);
    } catch (error) {
      log.error(`shutdown failed: ${error.message}`);
    }
  };

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => stop('context disposed'));
  } else if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => stop('context disposed'));
  }

  return () => stop('disposer called');
}

export { createBridge } from './bridge.js';
export { resolveConfig } from './config.js';
export { PROTOCOL_VERSION };
export { evtFrame };
