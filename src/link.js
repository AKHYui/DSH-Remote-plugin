/**
 * Outbound WebSocket link to the relay.
 *
 * Owns transport concerns only: dial, handshake, heartbeat, backoff and the
 * terminal-close rules. Frame semantics live in `bridge.js`.
 *
 * The plugin is always the dialer, so a desktop behind NAT never needs an
 * inbound port.
 */

import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import {
  ALL_CAPABILITIES,
  CLOSE,
  PROTOCOL_VERSION,
  attachUrl,
  decode,
  encode,
} from './protocol.js';

export const LinkState = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  HANDSHAKING: 'handshaking',
  READY: 'ready',
  STOPPED: 'stopped',
});

/** Close codes that mean "do not retry": retrying cannot fix them. */
const TERMINAL_CODES = new Set([CLOSE.PROTOCOL, CLOSE.UNAUTHORIZED]);

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const BACKOFF_JITTER = 0.2;

export function backoffDelay(attempt, random = Math.random) {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const spread = exponential * BACKOFF_JITTER;
  return Math.max(BACKOFF_BASE_MS, Math.round(exponential - spread + random() * spread * 2));
}

/** CA files already merged into the process trust store. */
const installedCaFiles = new Set();

/**
 * Trust a private CA at runtime.
 *
 * The WHATWG `WebSocket` takes no TLS options, so a relay behind a certificate
 * from an internal CA can only be reached by extending the process-wide default
 * trust store. `tls.setDefaultCACertificates()` (Node >= 22) does exactly that,
 * with no dependency and no restart — unlike `NODE_EXTRA_CA_CERTS`, which is read
 * once at process start.
 *
 * @returns {boolean} whether the CA is known to be installed.
 */
export function applyCustomCa(config, log) {
  const caFile = config?.tlsCaFile;
  if (!caFile) return false;
  if (installedCaFiles.has(caFile)) return true;

  if (typeof setDefaultCACertificates !== 'function' || typeof getCACertificates !== 'function') {
    log.error(
      `tlsCaFile is set but this Node build has no tls.setDefaultCACertificates(); ` +
        `set NODE_EXTRA_CA_CERTS=${caFile} and restart DSH instead`,
    );
    return false;
  }

  let pem;
  try {
    pem = readFileSync(caFile, 'utf8');
  } catch (error) {
    log.error(`tlsCaFile ${caFile} could not be read: ${error.message}`);
    return false;
  }

  try {
    setDefaultCACertificates([...getCACertificates('default'), pem]);
  } catch (error) {
    log.error(`tlsCaFile ${caFile} was rejected by the TLS layer: ${error.message}`);
    return false;
  }

  installedCaFiles.add(caFile);
  log.info(`trusting the certificate authority in ${caFile}`);
  return true;
}

export function createLink({
  config,
  log,
  platform = process.platform,
  harness = {},
  capabilities = ALL_CAPABILITIES,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
}) {
  const listeners = { ready: [], frame: [], down: [], state: [] };
  let socket = null;
  let state = LinkState.IDLE;
  let attempt = 0;
  let terminalReason = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastRxAt = 0;
  let lastTxAt = 0;
  let stopped = false;
  let welcomeFrame = null;
  let totalFrames = 0;

  function on(event, handler) {
    listeners[event].push(handler);
    return () => {
      const index = listeners[event].indexOf(handler);
      if (index >= 0) listeners[event].splice(index, 1);
    };
  }

  function emit(event, ...args) {
    for (const handler of [...listeners[event]]) {
      try {
        handler(...args);
      } catch (error) {
        log.error(`listener for "${event}" threw`, error);
      }
    }
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    emit('state', next);
  }

  function clearTimers() {
    if (reconnectTimer) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function send(frame) {
    if (!socket || socket.readyState !== 1) {
      throw new Error('link is not open');
    }
    socket.send(encode(frame));
    lastTxAt = now();
  }

  function trySend(frame) {
    try {
      send(frame);
      return true;
    } catch {
      return false;
    }
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) timers.clearTimeout(heartbeatTimer);
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null;
      if (stopped || state !== LinkState.READY) return;
      const idle = now() - lastRxAt;
      if (idle > config.heartbeatMs * 2.5) {
        log.warn(`no frame from relay for ${Math.round(idle / 1000)}s; forcing reconnect`);
        teardown('heartbeat timeout');
        scheduleReconnect();
        return;
      }
      trySend({ t: 'ping', id: `hb-${now()}` });
      scheduleHeartbeat();
    }, config.heartbeatMs);
  }

  function teardown(reason) {
    if (heartbeatTimer) {
      timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onclose = null;
      previous.onerror = null;
      try {
        previous.close(1000, reason ?? 'client teardown');
      } catch {
        /* already gone */
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || terminalReason) return;
    if (!config.reconnect) {
      setState(LinkState.IDLE);
      return;
    }
    attempt += 1;
    const delay = backoffDelay(attempt);
    setState(LinkState.IDLE);
    log.info(`reconnecting in ${delay}ms (attempt ${attempt})`);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

    // Must run before dialing, and before the WebSocket constructor is checked:
    // a private-CA relay needs the trust store extended first.
    applyCustomCa(config, log);

    if (typeof WebSocketImpl !== 'function') {
      terminalReason = 'no WebSocket implementation available in this runtime';
      log.error(terminalReason);
      setState(LinkState.STOPPED);
      return;
    }

    let url;
    try {
      url = attachUrl(config.serverUrl, config.connectorToken);
    } catch (error) {
      terminalReason = `invalid serverUrl: ${error.message}`;
      log.error(terminalReason);
      setState(LinkState.STOPPED);
      return;
    }

    setState(LinkState.CONNECTING);
    log.debug(`dialing ${url.replace(/token=[^&]+/, 'token=***')}`);

    let created;
    try {
      created = new WebSocketImpl(url);
    } catch (error) {
      log.warn(`could not open the socket: ${error.message}`);
      scheduleReconnect();
      return;
    }
    socket = created;

    created.onopen = () => {
      setState(LinkState.HANDSHAKING);
      lastRxAt = now();
      trySend({
        t: 'hello',
        v: PROTOCOL_VERSION,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        platform,
        harness,
        capabilities: [...capabilities],
      });
    };

    created.onmessage = (event) => {
      lastRxAt = now();
      totalFrames += 1;
      const result = decode(typeof event.data === 'string' ? event.data : String(event.data));
      if (!result.ok) {
        log.warn(`dropping a malformed relay frame: ${result.error.message}`);
        return;
      }
      const frame = result.frame;
      if (frame.t === 'welcome') {
        welcomeFrame = frame;
        attempt = 0;
        setState(LinkState.READY);
        scheduleHeartbeat();
        log.info(
          `connected to ${config.serverUrl} as device "${config.deviceId}" (relay protocol v${frame.v})`,
        );
        emit('ready', frame);
        return;
      }
      if (frame.t === 'bye') {
        terminalReason = `relay refused the session: ${frame.code} — ${frame.message}`;
        log.error(terminalReason);
        return;
      }
      emit('frame', frame);
    };

    created.onerror = () => {
      // The close event always follows; log at debug to avoid double noise.
      log.debug('socket error');
    };

    created.onclose = (event) => {
      const code = event?.code ?? 0;
      const reason = event?.reason ?? '';
      const wasReady = state === LinkState.READY;
      socket = null;
      if (heartbeatTimer) {
        timers.clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      emit('down', { code, reason, wasReady });

      if (stopped) {
        setState(LinkState.STOPPED);
        return;
      }

      if (TERMINAL_CODES.has(code)) {
        terminalReason =
          code === CLOSE.UNAUTHORIZED
            ? 'the connector token was rejected (revoked or never valid)'
            : 'the relay speaks a different protocol version';
        log.error(`${terminalReason}; not reconnecting`);
        setState(LinkState.STOPPED);
        return;
      }

      if (code === CLOSE.REPLACED && !config.reconnectOnReplaced) {
        terminalReason =
          'another DSH instance took over this device id; not reconnecting to avoid a reconnect storm';
        log.warn(terminalReason);
        setState(LinkState.STOPPED);
        return;
      }

      log.warn(`link closed (code ${code}${reason ? `, ${reason}` : ''})`);
      scheduleReconnect();
    };
  }

  function start() {
    if (!stopped && (state === LinkState.CONNECTING || state === LinkState.READY)) return;
    stopped = false;
    terminalReason = null;
    attempt = 0;
    connect();
  }

  function stop(reason = 'plugin shutdown') {
    stopped = true;
    clearTimers();
    teardown(reason);
    setState(LinkState.STOPPED);
  }

  return {
    on,
    start,
    stop,
    send,
    trySend,
    connect,
    get state() {
      return state;
    },
    get ready() {
      return state === LinkState.READY;
    },
    get terminalReason() {
      return terminalReason;
    },
    status() {
      return {
        state,
        ready: state === LinkState.READY,
        deviceId: config.deviceId,
        serverUrl: config.serverUrl,
        attempts: attempt,
        terminalReason,
        welcome: welcomeFrame,
        framesReceived: totalFrames,
        lastRxAt,
        lastTxAt,
      };
    },
  };
}
