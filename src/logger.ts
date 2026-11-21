type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : 'info';
if (process.env.VITEST) threshold = 'error';

const secrets = new Set<string>();

/** Registers a secret value that must never appear in logs. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function setLogLevel(level: Level): void {
  threshold = level;
}

/** Removes secrets, API keys in URLs and proxy credentials from any text. */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  out = out.replace(/([?&](?:apikey|api_key|key|token|access_token)=)[^&\s"']+/gi, '$1[redacted]');
  out = out.replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@');
  return out;
}

function serialize(value: unknown): string {
  if (value instanceof Error) {
    const cause = value.cause instanceof Error ? ` (cause: ${value.cause.message})` : '';
    return `${value.name}: ${value.message}${cause}`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) line += ` ${serialize(extra)}`;
  line = redact(line);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

export const log = createLogger('app');
