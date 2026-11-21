/** Validation / parsing helpers for untrusted EVM data. None of these throw. */

const HEX_QTY = /^0x[0-9a-fA-F]{0,64}$/;
const DEC = /^\d{1,78}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Parses a hex quantity ("0x1a", "0x" = 0). Returns null when malformed. */
export function hexQty(v: unknown): bigint | null {
  if (typeof v !== 'string' || !HEX_QTY.test(v)) return null;
  if (v === '0x') return 0n;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Hex quantity as a safe integer (block numbers, indexes). */
export function hexNum(v: unknown): number | null {
  const b = hexQty(v);
  if (b === null || b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}

/** Parses a decimal integer string (explorer APIs). */
export function decQty(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== 'string' || !DEC.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

export function decNum(v: unknown): number | null {
  const b = decQty(v);
  if (b === null || b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}

/** Lowercase address or null. */
export function addr(v: unknown): string | null {
  return typeof v === 'string' && ADDR.test(v) ? v.toLowerCase() : null;
}

/** Lowercase 32-byte hash or null. */
export function txHash(v: unknown): string | null {
  return typeof v === 'string' && HASH.test(v) ? v.toLowerCase() : null;
}

export function toHex(n: number | bigint): string {
  return '0x' + n.toString(16);
}

/** 32-byte topic for an address. */
export function addressTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** Extracts an address from a 32-byte topic; null if malformed or the upper 12 bytes are not zero. */
export function topicAddress(topic: unknown): string | null {
  if (typeof topic !== 'string' || !HASH.test(topic)) return null;
  const t = topic.toLowerCase();
  if (!/^0x0{24}/.test(t)) return null;
  return '0x' + t.slice(26);
}

/** Wei -> gwei as a number (fee rate display). */
export function weiToGwei(wei: bigint): number {
  return Number(wei) / 1e9;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
