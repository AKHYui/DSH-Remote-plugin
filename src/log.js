/** Minimal levelled logger with a stable prefix. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const PREFIX = '[dsh-remote-bridge]';

export function createLogger(level = 'info', sink = console) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (name, method, args) => {
    if (LEVELS[name] < threshold) return;
    const target = typeof sink[method] === 'function' ? sink[method] : sink.log;
    if (typeof target !== 'function') return;
    target.call(sink, PREFIX, ...args);
  };

  return {
    level,
    debug: (...args) => write('debug', 'debug', args),
    info: (...args) => write('info', 'info', args),
    warn: (...args) => write('warn', 'warn', args),
    error: (...args) => write('error', 'error', args),
  };
}

/** A logger that records everything, for tests. */
export function createMemoryLogger() {
  const entries = [];
  const make = (level) => (...args) => {
    entries.push({ level, message: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ') });
  };
  return {
    entries,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    text() {
      return entries.map((entry) => `${entry.level}: ${entry.message}`).join('\n');
    },
  };
}
