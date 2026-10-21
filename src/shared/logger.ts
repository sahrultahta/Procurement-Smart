import 'server-only';
import type { Clock } from './clock';
import { systemClock } from './clock';
import { readLogLevel, type LogLevel } from './env';

/**
 * Structured JSON logger with an allowlist (threat model I-05).
 * Only the fields below are ever written; anything else is dropped, so request
 * bodies and secrets cannot reach the log by accident.
 */
export type LoggedError = { name: string; message: string; sqlState?: string; constraint?: string };

export type LogFields = {
  requestId?: string;
  userId?: string | null;
  command?: string;
  durationMs?: number;
  outcome?: 'ok' | 'rejected' | 'failed';
  errorCode?: string;
  rule?: string;
  attempt?: number;
  error?: LoggedError;
};

export type LogSink = (level: LogLevel, line: string) => void;

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const ALLOWED_FIELDS = new Set<string>([
  'requestId',
  'userId',
  'command',
  'durationMs',
  'outcome',
  'errorCode',
  'rule',
  'attempt',
  'error',
]);
// Messages are event names, never interpolated data.
const MESSAGE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const MAX_ERROR_MESSAGE = 500;

const defaultSink: LogSink = (level, line) => {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export function createLogger(options: { level?: LogLevel; sink?: LogSink; clock?: Clock } = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? readLogLevel()];
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? systemClock;

  const write = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record: Record<string, unknown> = {
      level,
      time: clock.now().toISOString(),
      msg: MESSAGE_PATTERN.test(msg) ? msg : 'log.invalid_message',
    };
    for (const [key, value] of Object.entries(fields)) {
      if (ALLOWED_FIELDS.has(key) && value !== undefined) record[key] = value;
    }
    sink(level, JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/**
 * Reduces any thrown value to name, message, SQLSTATE, and constraint name.
 * Unwraps DrizzleQueryError (whose own message embeds the SQL text and parameters).
 * PostgreSQL `detail` (which can contain row values) is never included.
 */
export function describeError(error: unknown): LoggedError {
  const root = databaseErrorOf(error) ?? error;
  if (!(root instanceof Error)) return { name: 'NonError', message: truncate(String(root)) };
  const described: LoggedError = { name: root.name, message: truncate(root.message) };
  const { code, constraint } = root as { code?: unknown; constraint?: unknown };
  if (typeof code === 'string') described.sqlState = code;
  if (typeof constraint === 'string') described.constraint = constraint;
  return described;
}

/** The underlying node-postgres error (one with a SQLSTATE `code`), if any. */
export function databaseErrorOf(error: unknown): (Error & { code: string; constraint?: string }) | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return current as Error & { code: string; constraint?: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

export const logger: Logger = createLogger();
