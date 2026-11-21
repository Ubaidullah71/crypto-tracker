/** Time-zone helpers without external libraries (Intl based). */

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(tz: string, utcMs: number): Parts {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

function offsetMs(tz: string, utcMs: number): number {
  const p = zonedParts(tz, utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC ms of local midnight for the given local date in tz. Month is 1-based; overflow is normalized. */
export function zonedMidnight(tz: string, year: number, month: number, day: number): number {
  const guess = Date.UTC(year, month - 1, day);
  const off = offsetMs(tz, guess);
  let t = guess - off;
  const off2 = offsetMs(tz, t);
  if (off2 !== off) t = guess - off2;
  return t;
}

/** "YYYY-MM-DD" for the local date in tz. */
export function localDay(tz: string, utcMs = Date.now()): string {
  const p = zonedParts(tz, utcMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export type Period = 'today' | '7d' | '30d' | 'this_month' | 'last_month' | 'this_year' | 'last_year' | 'all';

export const PERIOD_CHOICES: Array<{ name: string; value: Period }> = [
  { name: 'Today', value: 'today' },
  { name: 'Last 7 days', value: '7d' },
  { name: 'Last 30 days', value: '30d' },
  { name: 'This month', value: 'this_month' },
  { name: 'Last month', value: 'last_month' },
  { name: 'This year', value: 'this_year' },
  { name: 'Last year', value: 'last_year' },
  { name: 'All time', value: 'all' },
];

/** [from, to) in unix seconds plus a readable label. */
export function periodRange(period: Period, tz: string, nowMs = Date.now()): { from: number; to: number; label: string } {
  const p = zonedParts(tz, nowMs);
  const sec = (ms: number) => Math.floor(ms / 1000);
  const now = sec(nowMs);
  const monthName = (y: number, m: number) =>
    new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  switch (period) {
    case 'today':
      return { from: sec(zonedMidnight(tz, p.year, p.month, p.day)), to: now + 1, label: 'Today' };
    case '7d':
      return { from: now - 7 * 86400, to: now + 1, label: 'Last 7 days' };
    case '30d':
      return { from: now - 30 * 86400, to: now + 1, label: 'Last 30 days' };
    case 'this_month':
      return { from: sec(zonedMidnight(tz, p.year, p.month, 1)), to: now + 1, label: monthName(p.year, p.month) };
    case 'last_month': {
      const y = p.month === 1 ? p.year - 1 : p.year;
      const m = p.month === 1 ? 12 : p.month - 1;
      return { from: sec(zonedMidnight(tz, y, m, 1)), to: sec(zonedMidnight(tz, p.year, p.month, 1)), label: monthName(y, m) };
    }
    case 'this_year':
      return { from: sec(zonedMidnight(tz, p.year, 1, 1)), to: now + 1, label: String(p.year) };
    case 'last_year':
      return { from: sec(zonedMidnight(tz, p.year - 1, 1, 1)), to: sec(zonedMidnight(tz, p.year, 1, 1)), label: String(p.year - 1) };
    case 'all':
    default:
      return { from: 0, to: now + 1, label: 'All time' };
  }
}

/** Parses "HH:MM" (24h). */
export function parseHhMm(s: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** Parses "YYYY-MM-DD" as local midnight in tz (unix seconds). */
export function parseLocalDate(s: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(zonedMidnight(tz, y, mo, d) / 1000);
}
