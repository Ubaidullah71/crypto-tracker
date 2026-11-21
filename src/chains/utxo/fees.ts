/** Fee-estimate parsing and the fee-rate -> confirmation-time mapping (pure). */
import { decimalToUnits } from '../../core/amount.ts';
import { isRecord } from './parse.ts';
import type { FeeEstimates } from './types.ts';

/** Confirmation targets (blocks) queried from the backends, ascending. */
export const FEE_TARGETS = [1, 2, 3, 6, 12, 24, 144] as const;

const DECIMAL_RE = /^\d{1,6}(\.\d{1,18})?$/;

/**
 * Blockbook /api/v2/estimatefee/{n} returns {"result":"0.00000986"} in coin per kB.
 * Returns sat/vB (0.00000986 -> 0.986) or null when missing / non-positive / malformed.
 */
export function coinPerKbToSatPerVb(raw: unknown): number | null {
  const result = isRecord(raw) ? raw.result : raw;
  if (typeof result !== 'string' || !DECIMAL_RE.test(result)) return null;
  try {
    const satPerKb = decimalToUnits(result, 8);
    if (satPerKb <= 0n) return null;
    return Number(satPerKb) / 1000;
  } catch {
    return null;
  }
}

/** Esplora GET /fee-estimates: {"1": 1.07, "144": 0.113, ...} already in sat/vB. */
export function parseEsploraFeeEstimates(raw: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!isRecord(raw)) return out;
  for (const target of FEE_TARGETS) {
    const v = raw[String(target)];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e6) out.set(target, v);
  }
  return out;
}

/**
 * Smallest target whose estimate is <= feeRate, converted to seconds. Null when the estimates are
 * empty, the fee rate is invalid, or it is below every estimate (including the 144-block one).
 */
export function secondsForFeeRate(estimates: FeeEstimates, feeRate: number, blockTimeSec: number): number | null {
  if (!Number.isFinite(feeRate) || feeRate <= 0 || estimates.size === 0) return null;
  const targets = [...estimates.keys()].sort((a, b) => a - b);
  for (const target of targets) {
    const est = estimates.get(target);
    // Small tolerance: fee rates are rounded to 0.01 sat/vB before they reach us.
    if (est !== undefined && feeRate + 1e-6 >= est) return Math.max(1, target) * blockTimeSec;
  }
  return null;
}
