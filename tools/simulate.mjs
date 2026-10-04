#!/usr/bin/env node
/**
 * Drives the bridge against a real relay using a stub DSH context.
 *
 * Use it to verify the relay end to end without installing anything into DSH:
 *
 *   node tools/simulate.mjs --server wss://relay.example.com/api/v1/attach \
 *        --token <connector-token> --device-id dev-sim
 *
 * Options:
 *   --server <url>        relay attach URL (required, or DSH_REMOTE_BRIDGE_SERVER_URL)
 *   --token <token>       connector token (required, or DSH_REMOTE_BRIDGE_TOKEN)
 *   --device-id <id>      device id (default: dev-sim)
 *   --seconds <n>         exit after n seconds (default: run until interrupted)
 *   --log <level>         debug|info|warn|error (default: info)
 *   --ask                 raise one approval request after 3s, to exercise the
 *                         phone approval path
 *   --approval-timeout-ms how long to wait for the phone before deferring to
 *                         the desktop answerer (default 90000)
 *   --ca <file>           PEM file of the CA that signed the relay certificate;
 *                         required when the relay uses an internal CA
 *   --events <ms>         emit a synthetic session event every ms (default 5000)
 *   --no-demo-ops         do not install the demo Remote handlers
 */

import { createBridge } from '../src/bridge.js';
import { createLogger } from '../src/log.js';
import { createFakeCtx } from './fake-ctx.mjs';

const SESSION_ID = 'sim-session-1';
const SECOND_SESSION_ID = 'sim-session-2';

function parseArgs(argv) {
  const args = {
    deviceId: 'dev-sim',
    log: 'info',
    seconds: 0,
    ask: false,
    events: 5000,
    demoOps: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--server': args.server = argv[++i]; break;
      case '--token': args.token = argv[++i]; break;
      case '--device-id': args.deviceId = argv[++i]; break;
      case '--seconds': args.seconds = Number(argv[++i]); break;
      case '--log': args.log = argv[++i]; break;
      case '--ask': args.ask = true; break;
      case '--ask-wait': args.askWait = true; break;
      case '--approval-timeout-ms': args.approvalTimeoutMs = Number(argv[++i]); break;
      case '--ca': args.ca = argv[++i]; break;
      case '--events': args.events = Number(argv[++i]); break;
      case '--no-demo-ops': args.demoOps = false; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (token.startsWith('--')) {
          throw new Error(`unknown option ${token}`);
        }
    }
  }
  return args;
}

function buildDemoOps(log) {
  const started = Date.now();
  const log1 = [];
  let seq = 0;
  let uploads = 0;
  let promptText = null;

  const push = (type, data) => {
    seq += 1;
    log1.push({ type, seq, time: Date.now(), data });
  };
  push('user/message', { role: 'user', content: [{ type: 'text', text: 'hello from the simulator' }] });

  return {
    ops: {
      'session.list': () => ({
        items: [
          { agentAvailable: true, sessionId: SESSION_ID, updatedAt: Date.now(), running: false, blank: false, cwd: process.cwd() },
          { agentAvailable: false, sessionId: SECOND_SESSION_ID, updatedAt: Date.now() - 60_000, running: false, blank: true },
        ],
      }),
      'session.page': (args) => ({
        records: log1.map((event) => ({ type: 'event', event })),
        hasMore: false,
        echoOf: args,
      }),
      'session.prompt': (args) => {
        promptText = args.content;
        push('user/message', { role: 'user', content: args.content ?? [] });
        log.info(`simulator received a prompt: ${JSON.stringify(args.content)}`);
        return { accepted: true };
      },
      'session.cancel': () => ({ accepted: true }),
      // Mirrors `fileUploads.upload`: `request.data` is base64 of the raw bytes
      // and the result carries the receipt `session.prompt` consumes. Checking
      // the base64 here is what makes a large-payload round trip meaningful —
      // a truncated frame would fail to decode rather than silently "pass".
      'fileUploads.upload': (args) => {
        const data = args?.request?.data;
        if (typeof data !== 'string') {
          const error = new Error('fileUploads.upload requires request.data');
          error.code = 'gateway/arguments-invalid';
          throw error;
        }
        const bytes = Buffer.from(data, 'base64');
        const name = args?.request?.name ?? 'sim.bin';
        uploads += 1;
        log.info(`simulator staged ${bytes.length} byte(s) as ${name}`);
        return {
          receiptId: `sim-receipt-${uploads}`,
          file: { attachmentId: `sim-attachment-${uploads}`, name, bytes: bytes.length },
        };
      },
      'session.create': () => ({ sessionId: `sim-${Date.now()}` }),
      'session.modelCatalog': () => ({
        default: { provider: 'simulator', model: 'sim-model' },
        routableProviders: ['simulator'],
        groups: [
          {
            id: 'simulator',
            name: 'Simulator',
            models: [{ id: 'sim-model', name: 'Simulated Model' }],
          },
        ],
        failures: [],
      }),
    },
    streams: {
      'session.follow': async function* (args, request) {
        yield { type: 'snapshot', header: { version: 1, id: SESSION_ID, createdAt: started, isSeeded: false }, cursor: seq, records: [], hasMore: false, projections: { asOfSeq: seq, values: {} } };
        let tick = 0;
        while (!request.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (request.signal?.aborted) break;
          tick += 1;
          seq += 1;
          yield {
            type: 'event',
            event: {
              type: 'assistant/message',
              seq,
              time: Date.now(),
              data: { turn: tick, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `tick ${tick}` }] }, stream: [] },
            },
          };
        }
      },
    },
    nextEvent() {
      seq += 1;
      return { sessionId: SESSION_ID, seq, type: 'assistant/message', time: Date.now(), data: { turn: seq, step: 1 } };
    },
    get promptText() {
      return promptText;
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${import.meta.url}\n`);
    return 0;
  }

  const server = args.server ?? process.env.DSH_REMOTE_BRIDGE_SERVER_URL;
  const token = args.token ?? process.env.DSH_REMOTE_BRIDGE_TOKEN;
  if (!server || !token) {
    process.stderr.write('error: --server and --token are required (or the DSH_REMOTE_BRIDGE_* env vars)\n');
    return 2;
  }

  const log = createLogger(args.log);
  const demo = args.demoOps ? buildDemoOps(log) : { ops: {}, streams: {}, nextEvent: () => null };
  const fake = createFakeCtx({ ops: demo.ops, streams: demo.streams });

  // The host's forwarded-Remote-event bookkeeping, reduced to what this plugin
  // touches: `dsh-api-gateway` keeps one `pending` record per forwarded waterfall
  // and `finishRemoteEvent` is what sends the client its `cancel` frame (which is
  // how a desktop window ends). Modelling it here means the withdrawal is
  // exercised end to end — through the real relay — instead of only in unit tests.
  const pendingRemoteEvents = new Map();
  let forwardedEvents = 0;
  fake.ctx.typertGateway.pendingRemoteEvents = pendingRemoteEvents;
  fake.ctx.typertGateway.finishRemoteEvent = (pending) => {
    if (pendingRemoteEvents.get(pending?.id) !== pending) return;
    pendingRemoteEvents.delete(pending.id);
    log.info(`desktop prompt withdrawn for ${pending.frame.event}`);
  };
  fake.ctx.typertGateway.cancelRemoteEvent = (pending) => {
    fake.ctx.typertGateway.finishRemoteEvent(pending);
  };

  const config = {
    serverUrl: server,
    connectorToken: token,
    deviceId: args.deviceId,
    deviceName: `${args.deviceId} (simulator)`,
    autoConnect: true,
    reconnect: true,
    reconnectOnReplaced: false,
    heartbeatMs: 30_000,
    approvalTimeoutMs: args.approvalTimeoutMs ?? 90_000,
    allowedSessions: [],
    allowInsecure: server.startsWith('ws://'),
    tlsCaFile: args.ca ?? '',
    logLevel: args.log,
  };

  const bridge = createBridge({
    ctx: fake.ctx,
    config,
    log,
    platform: 'simulator',
    harness: { version: 'simulator', node: process.version, gateway: true },
  });

  bridge.start();

  const timers = [];
  if (args.events > 0) {
    timers.push(
      setInterval(() => {
        const event = demo.nextEvent();
        if (event) fake.emit('session/event', { id: event.sessionId }, event);
      }, args.events),
    );
  }

  if (args.ask) {
    timers.push(
      setTimeout(() => {
        const handler = fake.listener('approval/request');
        const request = { agent: { id: SESSION_ID }, toolName: 'pwsh', reason: 'simulated approval' };
        log.info('raising a simulated approval request; answer it from the phone');
        const next = async () => {
          if (!args.askWait) {
            log.info('approval was NOT answered by the phone; the desktop answerer ran');
            return 'unavailable';
          }
          // What the real built-in forwarder does with `next()`: publish the request
          // as a forwarded Remote event and leave it **pending** until the desktop
          // answers. Nothing here ever answers it, so it stays pending — the exact
          // state the phone winning the race has to end.
          forwardedEvents += 1;
          const id = `sim-evt-${forwardedEvents}`;
          pendingRemoteEvents.set(id, {
            id,
            source: { event: 'approval/request', request, context: { agentId: SESSION_ID } },
            frame: {
              type: 'waterfall',
              event: 'approval/request',
              eventId: id,
              agentId: SESSION_ID,
              request: { callId: request.callId },
            },
          });
          log.info('the desktop prompt is waiting now (as the real forwarder leaves it)');
          return new Promise(() => {});
        };
        handler(request, next).then((outcome) => log.info(`approval outcome: ${outcome}`));
      }, 3_000),
    );
  }

  const shutdown = () => {
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    bridge.stop('simulator exiting');
    fake.dispose();
  };
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  log.info(`simulator running as "${args.deviceId}"; press Ctrl+C to stop`);

  if (args.seconds > 0) {
    setTimeout(() => {
      log.info('status: ' + JSON.stringify(bridge.status()));
      shutdown();
      process.exit(0);
    }, args.seconds * 1000);
  }

  return new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(`simulator failed: ${error.stack ?? error}\n`);
  process.exit(1);
});
