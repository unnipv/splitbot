import { EventEmitter } from 'node:events';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: Level;
  scope: string;
  msg: string;
  meta?: unknown;
}

const RING_SIZE = 500;
const ring: LogEntry[] = [];

/** Emits 'log' (LogEntry) and arbitrary app events ('status', 'job') for the dashboard SSE stream. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

const COLORS: Record<Level, string> = { debug: '\x1b[2m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

function write(level: Level, scope: string, msg: string, meta?: unknown) {
  const entry: LogEntry = { ts: Date.now(), level, scope, msg, meta };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit('log', entry);

  const ts = new Date(entry.ts).toISOString().slice(11, 23);
  const metaStr = meta === undefined ? '' : ' ' + (meta instanceof Error ? meta.stack : JSON.stringify(meta));
  const line = `\x1b[2m${ts}\x1b[0m ${COLORS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m [${scope}] ${msg}${metaStr}`;
  (level === 'error' ? console.error : console.log)(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, meta?: unknown) => write('debug', scope, msg, meta),
    info: (msg: string, meta?: unknown) => write('info', scope, msg, meta),
    warn: (msg: string, meta?: unknown) => write('warn', scope, msg, meta),
    error: (msg: string, meta?: unknown) => write('error', scope, msg, meta),
  };
}

export function recentLogs(): LogEntry[] {
  return [...ring];
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
