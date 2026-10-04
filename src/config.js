/**
 * Configuration resolution.
 *
 * Values come from the profile patch row (passed to `apply`) and may be
 * overridden by environment variables. The environment path exists so the
 * bridge can run even when the DSH loader hands us an empty config object, and
 * so tests and the simulator can drive it without touching a profile.
 */

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

export const DEFAULT_CONFIG = Object.freeze({
  serverUrl: '',
  connectorToken: '',
  deviceId: '',
  deviceName: '',
  autoConnect: true,
  reconnect: true,
  reconnectOnReplaced: false,
  heartbeatMs: 30_000,
  approvalTimeoutMs: 90_000,
  allowedSessions: [],
  allowInsecure: false,
  tlsCaFile: '',
  logLevel: 'info',
  // Archived Sessions are dropped from `session.list` before the phone sees them:
  // the desktop keeps them behind its own archive UI, and the phone has no way to
  // restore one, so listed as ordinary rows they were indistinguishable from live
  // conversations. Set to false to list them again — this is profile config, so it
  // takes effect in seconds without restarting DSH.
  hideArchivedSessions: true,
  // Opt-in diagnostic log. The packaged DSH has no log directory, so a plugin
  // has no way to report *why* it did not act; a waterfall handler that is never
  // called looks identical to one that declines.
  debugLog: '',
});

const ENV_KEYS = Object.freeze({
  serverUrl: 'DSH_REMOTE_BRIDGE_SERVER_URL',
  connectorToken: 'DSH_REMOTE_BRIDGE_TOKEN',
  deviceId: 'DSH_REMOTE_BRIDGE_DEVICE_ID',
  deviceName: 'DSH_REMOTE_BRIDGE_DEVICE_NAME',
  autoConnect: 'DSH_REMOTE_BRIDGE_AUTO_CONNECT',
  reconnect: 'DSH_REMOTE_BRIDGE_RECONNECT',
  heartbeatMs: 'DSH_REMOTE_BRIDGE_HEARTBEAT_MS',
  approvalTimeoutMs: 'DSH_REMOTE_BRIDGE_APPROVAL_TIMEOUT_MS',
  allowedSessions: 'DSH_REMOTE_BRIDGE_ALLOWED_SESSIONS',
  hideArchivedSessions: 'DSH_REMOTE_BRIDGE_HIDE_ARCHIVED_SESSIONS',
  allowInsecure: 'DSH_REMOTE_BRIDGE_ALLOW_INSECURE',
  tlsCaFile: 'DSH_REMOTE_BRIDGE_TLS_CA_FILE',
  logLevel: 'DSH_REMOTE_BRIDGE_LOG_LEVEL',
  debugLog: 'DSH_REMOTE_BRIDGE_DEBUG_LOG',
});

function readBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE.has(normalized)) return true;
    if (FALSE.has(normalized)) return false;
  }
  return undefined;
}

function readInt(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Merge defaults, profile config and environment overrides.
 *
 * @returns {{config: object, problems: string[], sources: object}}
 */
export function resolveConfig(rawConfig = {}, env = {}) {
  const problems = [];
  const sources = {};
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const config = { ...DEFAULT_CONFIG };

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const envName = ENV_KEYS[key];
    const envValue = envName ? env[envName] : undefined;
    let value;

    if (envValue !== undefined && envValue !== '') {
      value = envValue;
      sources[key] = 'env';
    } else if (raw[key] !== undefined && raw[key] !== '') {
      value = raw[key];
      sources[key] = 'profile';
    } else {
      continue;
    }

    switch (key) {
      case 'autoConnect':
      case 'reconnect':
      case 'reconnectOnReplaced':
      case 'hideArchivedSessions':
      case 'allowInsecure': {
        const bool = readBool(value);
        if (bool === undefined) problems.push(`${key}: expected a boolean, got ${JSON.stringify(value)}`);
        else config[key] = bool;
        break;
      }
      case 'heartbeatMs':
      case 'approvalTimeoutMs': {
        const int = readInt(value);
        if (int === undefined) problems.push(`${key}: expected an integer, got ${JSON.stringify(value)}`);
        else config[key] = int;
        break;
      }
      case 'allowedSessions': {
        const list = readList(value);
        if (list === undefined) problems.push(`${key}: expected an array or comma-separated string`);
        else config.allowedSessions = list;
        break;
      }
      default:
        config[key] = String(value);
    }
  }

  if (!config.serverUrl) {
    problems.push('serverUrl is empty: set it in the profile patch or DSH_REMOTE_BRIDGE_SERVER_URL');
  } else {
    let parsed;
    try {
      parsed = new URL(config.serverUrl);
    } catch {
      problems.push(`serverUrl is not a valid URL: ${config.serverUrl}`);
    }
    if (parsed) {
      const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
      if (!secure && !config.allowInsecure) {
        problems.push(
          `serverUrl must use wss:// (got ${parsed.protocol}//) — set allowInsecure only for local development`,
        );
      } else if (!secure) {
        problems.push('WARNING: allowInsecure is on; the connector token will travel in clear text');
      }
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      config.serverUrl = parsed.toString();
    }
  }

  if (!config.connectorToken) {
    problems.push('connectorToken is empty: mint one with `python -m app.cli issue-connector --name <label>`');
  }
  if (!config.deviceId) {
    problems.push('deviceId is empty: use a stable label such as "home-pc"');
  }
  if (config.heartbeatMs < 5_000) {
    problems.push(`heartbeatMs must be >= 5000 (got ${config.heartbeatMs})`);
  }
  if (config.approvalTimeoutMs < 1_000) {
    problems.push(`approvalTimeoutMs must be >= 1000 (got ${config.approvalTimeoutMs})`);
  }

  config.deviceName = config.deviceName || config.deviceId;

  // A warning is not fatal; only real problems block startup.
  const fatal = problems.filter((problem) => !problem.startsWith('WARNING:'));
  return { config, problems, fatal, sources };
}

export function isConfigured(config) {
  return Boolean(config.serverUrl && config.connectorToken && config.deviceId);
}
