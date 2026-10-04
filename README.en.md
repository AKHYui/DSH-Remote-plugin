# dsh-remote-bridge
[简体中文](README.md) | **English**

DeepSeek Harness plugin: connects the machine running DSH to your own relay over an **outbound** WSS, so the mobile app can list sessions, send messages, and answer approvals and questions from anywhere. Zero runtime dependencies.

## What it is

- Installed on the **DSH host** (not on the relay server) and loaded by DSH as a plugin.
- Path: mobile app → relay → this plugin → DSH. The plugin is always the side that dials out.
- What it exposes: list sessions, follow the live event stream, send messages (text / inline images / uploaded files via `receiptId`), switch models, cancel a turn, and answer approvals plus `ask_user_question` prompts.
- Requires a deployed relay ([DSH-Remote-backend](https://github.com/AKHYui/DSH-Remote-backend)) and a connector token issued by it.
- Security boundary: **whoever holds the phone token can run commands on this machine.** Treat the relay and the phone token as equally sensitive.

## Architecture

```
Mobile app ──HTTPS/WSS──▶ relay ◀──outbound WSS── dsh-remote-bridge ──▶ DSH host (sessions, tools, models)
```

The plugin only makes outbound connections (`wss://<relay-host>:<port>/api/v1/attach`), so the host needs **no inbound port** open in its firewall and works behind home NAT or without a public IP.
The relay only authenticates, rate-limits, forwards and audits; it never parses or stores session content.

## Requirements

| Item | Requirement |
|---|---|
| OS | Linux (every command below is copy-pasteable; Windows / macOS differences are noted per section as `> Windows:`) |
| DSH | A build that provides the `dsh plugin` command; this plugin is verified against the `desktop` profile |
| Node.js | `>=22.19` (`engines` in `package.json`). The plugin runs inside the runtime DSH ships, so you normally do not install Node yourself — only `tools/simulate.mjs` needs your own |
| Relay | Deployed and reachable, exposing a `wss://…/api/v1/attach` endpoint |
| Credentials | A `connectorToken` issued by the relay (one per machine, revocable individually) |
| Optional | When the relay certificate is signed by a private CA: a PEM file of that CA (configured as `tlsCaFile`) |

## Deployment

Four steps: issue a token → install the plugin → write the config → restart DSH.

### 1. Issue a connector token on the relay

```bash
cd /opt/dsh-backend
sudo -u dshrelay env DSH_RELAY_DB=/opt/dsh-backend/var/relay.db \
  .venv/bin/python -m app.cli issue-connector --name home-pc
```

- `dshrelay` is the backend repository's default service account; substitute your own service user. `DSH_RELAY_DB` points at the relay's SQLite database.
- The `token` in the output is your `connectorToken`; the `--name` value (`home-pc` above) is normally reused as `deviceId`.
- The token is **shown once**. Store it in a password manager; if it leaks, revoke it with `revoke-connector` and issue a new one.

### 2. Install the plugin

```bash
sudo mkdir -p /opt/dsh-remote-bridge
sudo chown "$USER" /opt/dsh-remote-bridge
git clone https://github.com/AKHYui/DSH-Remote-plugin.git /opt/dsh-remote-bridge
dsh plugin --profile desktop add link:/opt/dsh-remote-bridge
```

- The `link:` path is the **repository root** (where `package.json` lives), not a subdirectory of it.
- Installation inserts a `remote-bridge` entry into that profile from the patch layer the package ships in `cordis.patch.yml`. Its config is empty at that point, so the plugin does not start; the next step overrides it by `id`.

> Windows: any directory works (e.g. `D:\dsh-remote-bridge`); point `link:` at it.

### 3. Write the config

Append to `~/.dsh/profiles/desktop/cordis.patch.yml` (key names match `DEFAULT_CONFIG` in `src/config.js`):

```yaml
- id: remote-bridge
  name: dsh-remote-bridge
  config:
    serverUrl: 'wss://relay.example.com:58443/api/v1/attach'
    connectorToken: '<connector token>'
    deviceId: 'home-pc'
    deviceName: 'home-pc'
    tlsCaFile: '/etc/dsh-remote-bridge/ca.crt'
    autoConnect: true
    reconnect: true
    heartbeatMs: 30000
    approvalTimeoutMs: 90000
    allowedSessions: []
    hideArchivedSessions: true
    allowInsecure: false
    logLevel: info
    debugLog: '/tmp/dsh-remote-bridge.log'
```

- `serverUrl` must be the relay's attach endpoint; `https://` or `http://` is rewritten to `wss://` or `ws://` automatically.
- `tlsCaFile` points at the CA that signed the relay certificate (PEM), in a location the DSH process can read. The plugin adds it to the process trust store before dialing.
- `connectorToken` is a secret: you can keep it out of the file entirely by setting `DSH_REMOTE_BRIDGE_TOKEN` instead (the environment wins over this key).
- Any key can be overridden by its `DSH_REMOTE_BRIDGE_*` environment variable; see **Configuration** below.
- `debugLog` must point at a file the DSH process can **write**; write failures are ignored silently.

> Windows: use Windows paths, e.g. `tlsCaFile: 'D:\dsh-remote-bridge\certs\ca.crt'` (backslashes are literal inside single quotes).

### 4. Restart DSH

Restart DSH the way you started it: `systemctl --user restart` for your DSH service, quit and reopen it in a desktop session, or `Ctrl-C` and rerun it in the foreground.

> **Changes to `src/` only take effect after DSH restarts.** The host does no HMR, and Node's ESM module cache survives disabling, enabling and reinstalling a plugin.
> **Config in the profile patch is live**: within seconds the plugin is recreated and reads the new values, with no restart.

### 5. Confirm the link is up

```bash
tail -n 5 /tmp/dsh-remote-bridge.log    # this file exists only when debugLog is set
```

DSH's own output (console or log) should also show `connected to wss://… as device "home-pc" (relay protocol v1)`.

| Log line | Meaning |
|---|---|
| `bridge init deviceId=home-pc debugLog=/tmp/dsh-remote-bridge.log` | Written every time the plugin is created; use it to tell whether a config change took effect |
| `desktop withdraw: {"gateway":true,…,"finishRemoteEvent":true,…}` | Startup self-check: the host internals needed to withdraw the desktop prompt when the phone answers first are available. With `finishRemoteEvent:false` withdrawal is inert — **everything else still works** |
| `reconnecting in 1000ms (attempt 1)` | The link is not up yet; it retries with exponential backoff (1s, ×2, capped at 30s) |

### Verifying without installing into DSH

Run the **real plugin** against a real relay with a stub context — no DSH involved:

```bash
cd /opt/dsh-remote-bridge
node tools/simulate.mjs --server wss://relay.example.com:58443/api/v1/attach \
  --token '<connector token>' --device-id dev-sim --ca /etc/dsh-remote-bridge/ca.crt
```

Useful flags: `--ask` raises one simulated approval after three seconds; `--events <ms>` synthesizes a session event every `<ms>` milliseconds (`0` disables it, default 5000); `--seconds <n>` exits after n seconds; `--log <level>` sets the log level; `--no-demo-ops` skips the demo Remote handlers. Full list: `node tools/simulate.mjs --help`.

## Configuration

Keys can live in the profile patch's `config:` or in the matching environment variable (**the environment wins**).

| Key | Environment variable | Default | Notes |
|---|---|---|---|
| `serverUrl` | `DSH_REMOTE_BRIDGE_SERVER_URL` | empty | **Required.** Relay attach URL, `wss://<host>:<port>/api/v1/attach` |
| `connectorToken` | `DSH_REMOTE_BRIDGE_TOKEN` | empty | **Required.** Connector token issued by the relay (a secret). Prefer the environment variable |
| `deviceId` | `DSH_REMOTE_BRIDGE_DEVICE_ID` | empty | **Required.** Stable id for this machine; the phone addresses it by this, and it must be unique per relay |
| `deviceName` | `DSH_REMOTE_BRIDGE_DEVICE_NAME` | `deviceId` | Display name |
| `autoConnect` | `DSH_REMOTE_BRIDGE_AUTO_CONNECT` | `true` | Dial immediately after load; with `false` the plugin is loaded but sends no traffic |
| `reconnect` | `DSH_REMOTE_BRIDGE_RECONNECT` | `true` | Reconnect after a drop (exponential backoff: 1s, ×2, cap 30s, ±20% jitter) |
| `reconnectOnReplaced` | none | `false` | Whether to take the link back after a new connection with the same `deviceId` replaced it (close code `4001`) |
| `heartbeatMs` | `DSH_REMOTE_BRIDGE_HEARTBEAT_MS` | `30000` | Keepalive interval; **minimum 5000** |
| `approvalTimeoutMs` | `DSH_REMOTE_BRIDGE_APPROVAL_TIMEOUT_MS` | `90000` | How long to wait for the phone before falling back to the desktop answerer; **minimum 1000** |
| `allowedSessions` | `DSH_REMOTE_BRIDGE_ALLOWED_SESSIONS` | `[]` | Session allowlist (array or comma-separated string). Empty allows everything; it also gates approval / question forwarding |
| `hideArchivedSessions` | `DSH_REMOTE_BRIDGE_HIDE_ARCHIVED_SESSIONS` | `true` | Drop archived sessions from `session.list`; set `false` to list them again |
| `allowInsecure` | `DSH_REMOTE_BRIDGE_ALLOW_INSECURE` | `false` | Allow `ws://`. **Local development only**: the token travels in clear text and a WARNING is logged |
| `tlsCaFile` | `DSH_REMOTE_BRIDGE_TLS_CA_FILE` | empty | CA that signed the relay certificate (PEM file path) |
| `logLevel` | `DSH_REMOTE_BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `debugLog` | `DSH_REMOTE_BRIDGE_DEBUG_LOG` | empty (off) | Diagnostic log file path; **off by default** |

Boolean keys accept `1/true/yes/on` and `0/false/no/off` (case-insensitive); `allowedSessions` accepts an array or a comma-separated string;
`heartbeatMs` and `approvalTimeoutMs` below their floors refuse to start.

## Operations and troubleshooting

| Symptom | What to do |
|---|---|
| DSH prints `not starting: N configuration problem(s) above` | Missing or invalid config. Three keys are required (`serverUrl`, `connectorToken`, `deviceId`), and `heartbeatMs >= 5000`, `approvalTimeoutMs >= 1000` |
| Every op from the phone answers `op_not_supported` | The plugin is an older build → restart DSH |
| Close code `4401`: `the connector token was rejected` | The token was revoked or was never valid → issue a new one on the relay and update the config (config is live, seconds to apply) |
| Close code `4001`: `another DSH instance took over this device id` | Two machines share one `deviceId` → make it unique; only enable `reconnectOnReplaced` if the earlier one really should win the link back |
| Close code `4400`: protocol version mismatch | The plugin and relay disagree on the wire protocol → upgrade both; do not relax validation to get around it |
| Reconnects in a fixed ~30s cycle | The relay treats the plugin's `ping` as an invalid frame (older relays only accepted one-way heartbeats) → upgrade the relay |
| `tlsCaFile` is set but the link still fails | That PEM is not the CA that signed the relay certificate, or the DSH process cannot read it. Verify the path; the fallback is `NODE_EXTRA_CA_CERTS=<PEM>` plus a DSH restart |
| `src/` changed but the behaviour did not | DSH must be restarted (see Deployment step 4) |
| The `debugLog` file stays empty | The path is not writable by the DSH process, or `debugLog` is unset; write failures are silent |
| The phone still lists archived sessions | `hideArchivedSessions` is `false`, the plugin is an older build (restart DSH), or the phone's task list has not refreshed yet (reopening the drawer refreshes it) |
| The phone lists no sessions at all | `allowedSessions` is set and none of those session ids are in it |
| Approvals / questions never reach the phone | The phone must be able to receive the relay's live events, or fetch the pending list when the app is reopened; after `approvalTimeoutMs` the request falls back to the desktop answerer |

## Tests

```bash
cd /opt/dsh-remote-bridge
node --test                      # 149 cases across 8 test files
node --test test/ops.test.js     # a single file
npm test                         # same thing (zero dependencies, no npm install needed)
```

## Repository layout

| Path | Contents |
|---|---|
| `src/index.js` | Plugin entry: config validation, startup and disposal |
| `src/bridge.js` | Wires transport, op table, event fan-out, approvals and withdrawal into one disposable unit |
| `src/link.js` | Outbound WSS: dialing, `hello`, heartbeat, backoff reconnect, runtime CA trust |
| `src/protocol.js` | Protocol constants: `PROTOCOL_VERSION`, frame codec, **op allowlist**, topics, error and close codes |
| `src/ops.js` | op → host Remote mapping, argument wrapping, `allowedSessions` and archived filtering |
| `src/events.js` | Subscription management and event fan-out (bounded queue; a slow link never blocks the host) |
| `src/approvals.js` | Approval / question bridging: racing the desktop, timeout, cancel and link-loss fallbacks |
| `src/desktop-withdraw.js` | Settles the desktop's pending request when the phone answers first, so the desktop prompt closes itself |
| `src/config.js` | Config resolution and validation (profile `config:` + `DSH_REMOTE_BRIDGE_*`) |
| `src/log.js`, `src/debug-log.js` | Levelled console logging; optional diagnostic file log |
| `test/` | 8 test files, 149 cases |
| `tools/simulate.mjs` | Runs the real plugin against a real relay through a stub context (integration without DSH) |
| `tools/fake-ctx.mjs` | Stub `ctx` and WebSocket stand-in used by the tests and the simulator |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Wire protocol, frame types and the op contract |
| `cordis.patch.yml` | The patch layer the package ships: inserts the plugin entry into the profile; your profile patch overrides its config |

## Related repositories

- [DSH-Remote-plugin](https://github.com/AKHYui/DSH-Remote-plugin) — this repository, the DSH desktop plugin
- [DSH-Remote-backend](https://github.com/AKHYui/DSH-Remote-backend) — the relay service (FastAPI + SQLite)
- [DSH-Remote-app](https://github.com/AKHYui/DSH-Remote-app) — the Flutter mobile client

## License

MIT, see [LICENSE](LICENSE).
