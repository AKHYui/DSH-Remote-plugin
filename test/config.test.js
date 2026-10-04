import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, isConfigured, resolveConfig } from '../src/config.js';

const BASE = {
  serverUrl: 'wss://relay.example.com/api/v1/attach',
  connectorToken: 'secret-token',
  deviceId: 'home-pc',
};

test('a complete config resolves with defaults', () => {
  const { config, fatal, sources } = resolveConfig(BASE, {});
  assert.deepEqual(fatal, []);
  assert.equal(config.serverUrl, 'wss://relay.example.com/api/v1/attach');
  assert.equal(config.connectorToken, 'secret-token');
  assert.equal(config.deviceId, 'home-pc');
  assert.equal(config.deviceName, 'home-pc', 'deviceName falls back to deviceId');
  assert.equal(config.autoConnect, true);
  assert.equal(config.reconnect, true);
  assert.equal(config.reconnectOnReplaced, false);
  assert.equal(config.heartbeatMs, DEFAULT_CONFIG.heartbeatMs);
  assert.equal(config.approvalTimeoutMs, DEFAULT_CONFIG.approvalTimeoutMs);
  assert.deepEqual(config.allowedSessions, []);
  assert.equal(sources.serverUrl, 'profile');
  assert.equal(isConfigured(config), true);
});

test('environment overrides the profile config', () => {
  const { config, sources } = resolveConfig(BASE, {
    DSH_REMOTE_BRIDGE_SERVER_URL: 'wss://other.example.com/attach',
    DSH_REMOTE_BRIDGE_DEVICE_ID: 'from-env',
    DSH_REMOTE_BRIDGE_HEARTBEAT_MS: '45000',
    DSH_REMOTE_BRIDGE_AUTO_CONNECT: 'false',
  });
  assert.equal(config.serverUrl, 'wss://other.example.com/attach');
  assert.equal(config.deviceId, 'from-env');
  assert.equal(config.heartbeatMs, 45_000);
  assert.equal(config.autoConnect, false);
  assert.equal(sources.deviceId, 'env');
  assert.equal(sources.connectorToken, 'profile');
});

test('https and http are normalised to websocket schemes', () => {
  assert.equal(
    resolveConfig({ ...BASE, serverUrl: 'https://relay.example.com/attach' }, {}).config.serverUrl,
    'wss://relay.example.com/attach',
  );
  const insecure = resolveConfig({ ...BASE, serverUrl: 'http://127.0.0.1:8787/attach', allowInsecure: true }, {});
  assert.equal(insecure.config.serverUrl, 'ws://127.0.0.1:8787/attach');
});

test('a plaintext relay is refused unless allowInsecure is set', () => {
  const { fatal } = resolveConfig({ ...BASE, serverUrl: 'ws://127.0.0.1:8787/attach' }, {});
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /must use wss:\/\//);
});

test('allowInsecure produces a warning, not a failure', () => {
  const { problems, fatal } = resolveConfig(
    { ...BASE, serverUrl: 'ws://127.0.0.1:8787/attach', allowInsecure: true },
    {},
  );
  assert.deepEqual(fatal, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^WARNING:/);
});

test('missing required keys are fatal and reported individually', () => {
  const { fatal, problems } = resolveConfig({}, {});
  assert.equal(fatal.length, 3);
  assert.ok(problems.some((problem) => problem.includes('serverUrl is empty')));
  assert.ok(problems.some((problem) => problem.includes('connectorToken is empty')));
  assert.ok(problems.some((problem) => problem.includes('deviceId is empty')));
});

test('an invalid server URL is rejected', () => {
  const { fatal } = resolveConfig({ ...BASE, serverUrl: 'not a url' }, {});
  assert.ok(fatal.some((problem) => problem.includes('not a valid URL')));
});

test('numeric and boolean fields are validated', () => {
  const bad = resolveConfig(
    { ...BASE, heartbeatMs: 'soon', approvalTimeoutMs: 'later', reconnect: 'maybe' },
    {},
  );
  assert.ok(bad.fatal.some((problem) => problem.includes('heartbeatMs: expected an integer')));
  assert.ok(bad.fatal.some((problem) => problem.includes('approvalTimeoutMs: expected an integer')));
  assert.ok(bad.fatal.some((problem) => problem.includes('reconnect: expected a boolean')));
});

test('intervals below the safety floor are refused', () => {
  const { fatal } = resolveConfig({ ...BASE, heartbeatMs: 1000, approvalTimeoutMs: 10 }, {});
  assert.ok(fatal.some((problem) => problem.includes('heartbeatMs must be >= 5000')));
  assert.ok(fatal.some((problem) => problem.includes('approvalTimeoutMs must be >= 1000')));
});

test('hideArchivedSessions defaults on and can be switched off three ways', () => {
  // Default: archived Sessions never reach the phone.
  assert.equal(resolveConfig(BASE, {}).config.hideArchivedSessions, true);
  // Profile patch — a live change, no DSH restart.
  assert.equal(resolveConfig({ ...BASE, hideArchivedSessions: false }, {}).config.hideArchivedSessions, false);
  // Environment override wins.
  const fromEnv = resolveConfig({ ...BASE, hideArchivedSessions: false }, {
    DSH_REMOTE_BRIDGE_HIDE_ARCHIVED_SESSIONS: '1',
  });
  assert.equal(fromEnv.config.hideArchivedSessions, true);
  assert.equal(fromEnv.sources.hideArchivedSessions, 'env');
  // Junk is reported rather than silently treated as false.
  const bad = resolveConfig({ ...BASE, hideArchivedSessions: 'sometimes' }, {});
  assert.ok(bad.fatal.some((problem) => problem.includes('hideArchivedSessions: expected a boolean')));
});

test('allowedSessions accepts an array or a comma-separated string', () => {  assert.deepEqual(resolveConfig({ ...BASE, allowedSessions: ['a', 'b'] }, {}).config.allowedSessions, ['a', 'b']);
  assert.deepEqual(resolveConfig({ ...BASE, allowedSessions: 'a, b ,c' }, {}).config.allowedSessions, ['a', 'b', 'c']);
  assert.deepEqual(
    resolveConfig(BASE, { DSH_REMOTE_BRIDGE_ALLOWED_SESSIONS: 'x,y' }).config.allowedSessions,
    ['x', 'y'],
  );
});

test('booleans accept the usual spellings', () => {
  for (const value of ['1', 'true', 'YES', 'on', true]) {
    assert.equal(resolveConfig({ ...BASE, autoConnect: value }, {}).config.autoConnect, true);
  }
  for (const value of ['0', 'false', 'No', 'off', false]) {
    assert.equal(resolveConfig({ ...BASE, autoConnect: value }, {}).config.autoConnect, false);
  }
});

test('an empty config object is treated as unconfigured, not as a crash', () => {
  const { config } = resolveConfig(undefined, {});
  assert.equal(isConfigured(config), false);
  assert.equal(config.heartbeatMs, DEFAULT_CONFIG.heartbeatMs);
});

test('a non-object config is ignored rather than throwing', () => {
  const { config } = resolveConfig('nonsense', {});
  assert.equal(isConfigured(config), false);
});
