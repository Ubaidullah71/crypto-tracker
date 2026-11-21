/** Exact conversions between integer base units (bigint) and decimal strings. */

export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  if (decimals === 0) return (neg ? '-' : '') + abs.toString();
  const s = abs.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal amount: "${input}"`);
  const neg = s.startsWith('-');
  const [intPart = '0', fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  if (fracPart.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  const v = BigInt(intPart + fracPart.padEnd(decimals, '0'));
  return neg ? -v : v;
}

/** Converts base units to a JS number (for prices/percentages; not for exact accounting). */
export function toNumber(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

/** Parses a decimal string (e.g. "0.00001234" or "1e-8") into base units, rounding toward zero. */
export function decimalToUnits(input: string | number, decimals: number): bigint {
  let s = typeof input === 'number' ? input.toFixed(Math.min(decimals, 20)) : input.trim();
  if (/e/i.test(s)) s = Number(s).toFixed(Math.min(decimals, 20));
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [i = '0', f = ''] = s.split('.');
  const v = BigInt((i || '0') + f.slice(0, decimals).padEnd(decimals, '0'));
  return neg ? -v : v;
}

/** Hex quantity (0x...) to bigint; "0x" and empty are 0. */
export function hexToBigInt(hex: string | null | undefined): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

export function hexToNumber(hex: string | null | undefined): number {
  return Number(hexToBigInt(hex));
}

export function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}
