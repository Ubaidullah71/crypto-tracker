/** Display formatting. Plain text only: no emoji or decorative symbols. */

const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234.56"; small values keep significant digits ("$0.07891"). */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (a === 0) s = '0.00';
  else if (a >= 0.01) s = usd2.format(a);
  else if (a >= 0.000001) s = String(Number(a.toPrecision(2)));
  else return `${neg ? '-' : ''}<$0.000001`;
  return `${neg ? '-' : ''}$${s}`;
}

/** Price formatting with more precision for cheap assets. Never uses exponent notation. */
export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1) return usd(n);
  if (a === 0) return '$0.00';
  if (a < 0.000001) return '<$0.000001';
  // 4 significant digits, written out in full (0.07804, 0.0001234).
  const decimals = Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(a))));
  return `${n < 0 ? '-' : ''}$${a.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, '$1')}`;
}

/** Short money for tables: no cents from $1,000 up ("$10,284"), cents below ("$85.03"). */
export function usdShort(n: number | null | undefined, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : signed && a >= 0.005 ? '+' : '';
  if (a >= 1000) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  if (a >= 0.01 || a === 0) return `${sign}$${a.toFixed(2)}`;
  return `${sign}${price(a)}`;
}

export function signedUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) < 0.005) return '$0.00';
  return `${n > 0 ? '+' : '-'}${usd(Math.abs(n))}`;
}

/** "+1.23%". Absurd values (from a near-zero base) are shown as "n/a" instead of 1e+44%. */
export function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) >= 1_000_000) return 'n/a';
  const v = Math.abs(n) < 0.5 * 10 ** -digits ? 0 : n;
  const body = Math.abs(v) >= 10_000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(digits);
  return `${v > 0 ? '+' : ''}${body}%`;
}

/**
 * Quantity with sensible precision: stablecoins 2 decimals, large amounts fewer decimals,
 * small amounts up to 8 decimals ("10,293.37 USDT", "75.2231 SOL", "0.03078824 BTC").
 */
export function qty(value: number, stable = false): string {
  if (!Number.isFinite(value)) return 'n/a';
  const a = Math.abs(value);
  const decimals = stable ? 2 : a >= 1000 ? 2 : a >= 1 ? 4 : 8;
  return amount(value, decimals);
}

/** "+$12.34 (+5.67%)" */
export function pnl(value: number | null | undefined, percent: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return percent === null || percent === undefined || !Number.isFinite(percent)
    ? signedUsd(value)
    : `${signedUsd(value)} (${pct(percent)})`;
}

/** Formats a decimal string or number with thousands separators, trimming trailing zeros. */
export function amount(value: string | number, maxDecimals = 8): string {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'n/a';
    s = value.toFixed(Math.min(maxDecimals, 12));
  } else s = value;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [int = '0', frac = ''] = s.split('.');
  frac = frac.slice(0, maxDecimals).replace(/0+$/, '');
  int = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (int === '0' && !frac && typeof value === 'string' && /[1-9]/.test(value)) {
    // Dust smaller than maxDecimals: show the significant part instead of "0".
    const [, f = ''] = value.replace('-', '').split('.');
    const firstSig = f.search(/[1-9]/);
    frac = f.slice(0, firstSig + 3).replace(/0+$/, '');
  }
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export function coin(value: string | number, symbol: string, maxDecimals = 8): string {
  return `${amount(value, maxDecimals)} ${symbol}`;
}

/** "4m 26s", "2h 5m", "3d 4h", "12s" */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/** Discord timestamp markup; renders in each viewer's own time zone. */
export function ts(unixSec: number | null | undefined, style: TimestampStyle = 'f'): string {
  if (!unixSec) return 'n/a';
  return `<t:${Math.floor(unixSec)}:${style}>`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + '...';
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;
}

/** Masked link that is safe for embed text (escapes brackets in labels). */
export function link(label: string, url: string): string {
  const safe = label.replace(/[[\]]/g, '');
  return `[${safe}](${url})`;
}
