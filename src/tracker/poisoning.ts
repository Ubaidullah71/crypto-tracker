/**
 * Address poisoning: after you pay someone, scammers send you dust from an address that starts and
 * ends like the recipient's, hoping you copy it from your history next time. Such dust is hidden
 * from lists and notifications (it still counts, it is real balance), and real payments from
 * look-alikes get a warning.
 */
import { toNumber } from '../core/amount.ts';
import { ASSETS } from '../core/assets.ts';
import type { NetworkId } from '../core/networks.ts';
import { getDb } from '../db/database.ts';
import { getSetting, setSetting, transfers, walletNetworks, type TransferRow } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import { normalizeAddr } from '../portfolio/classify.ts';
import { effectivePrice } from '../portfolio/portfolio.ts';
import { getPriceService } from '../prices/prices.ts';

const log = createLogger('poisoning');

/** Incoming transfers below this value (USD) from a look-alike address count as poisoning dust. */
export const DUST_USD = 1;
export const POISONING_NOTE = 'Dust from a look-alike address (address poisoning); hidden automatically. Never send to this address.';
/** Settings key: highest transfer id already checked, so each transfer is looked at once. */
const CHECKED_KEY = 'poisoningCheckedId';
const BATCH = 5000;

/**
 * The part of an address people compare: without the prefix every address of its type shares
 * (0x, bc1q, ltc1p, or the version character of base58 BTC, LTC and XRP addresses).
 */
function body(a: string): string {
  const prefix = /^(0x|bc1[a-z]|ltc1[a-z])/i.exec(a);
  if (prefix) return a.slice(prefix[0].length);
  if (/^[13LMr]/.test(a) && a.length <= 35) return a.slice(1);
  return a;
}
const sameChars = (a: string, b: string) => [...a].filter((ch, i) => ch === b[i]).length;

/**
 * True when `cp` is a different address that looks like `known` at a glance: 3 of the first 4 and
 * 3 of the last 4 characters in place (wallets usually show only those). For dust, matching last 4
 * characters alone is enough. Both addresses must be normalized (see normalizeAddr).
 */
export function imitates(known: string, cp: string, dust = false): boolean {
  if (known === cp) return false;
  const k = body(known);
  const c = body(cp);
  if (k.length < 12 || c.length < 12) return false;
  const tail = sameChars(k.slice(-4), c.slice(-4));
  if (sameChars(k.slice(0, 4), c.slice(0, 4)) >= 3 && tail >= 3) return true;
  return dust && tail === 4;
}

/** Your own addresses on a network plus everyone you have sent to (normalized). */
export function knownAddresses(network: NetworkId): Set<string> {
  const known = new Set<string>();
  for (const w of walletNetworks.all()) if (w.network === network) known.add(normalizeAddr(w.address));
  const rows = getDb().all<{ counterparty: string }>(
    `SELECT counterparty FROM transfers WHERE network = ? AND direction = 'out' AND counterparty IS NOT NULL
     GROUP BY counterparty ORDER BY MAX(id) DESC LIMIT 5000`,
    [network],
  );
  for (const r of rows) known.add(normalizeAddr(r.counterparty));
  return known;
}

/** The look-alike known address, or null. */
export function imitatedAddress(cp: string, known: Set<string>, dust = false): string | null {
  const c = normalizeAddr(cp);
  if (known.has(c)) return null;
  for (const k of known) if (imitates(k, c, dust)) return k;
  return null;
}

async function usdValue(t: TransferRow): Promise<number | null> {
  const qty = toNumber(BigInt(t.amount), t.decimals);
  if (ASSETS[t.asset].stablecoin) return qty;
  const price =
    effectivePrice(t) ??
    (await getPriceService()
      .getPrice(t.asset)
      .catch(() => null));
  return price === null ? null : qty * price;
}

let running: Promise<number> | null = null;

/**
 * Checks transfers stored since the last run and hides incoming poisoning dust. Each transfer is
 * checked once, so setting a category yourself (which shows it again) is never overridden.
 */
export function markPoisoningDust(): Promise<number> {
  running ??= sweep().finally(() => {
    running = null;
  });
  return running;
}

async function sweep(): Promise<number> {
  const from = getSetting<number>(CHECKED_KEY) ?? 0;
  const rows = getDb().all<TransferRow>('SELECT * FROM transfers WHERE id > ? ORDER BY id LIMIT ?', [from, BATCH]);
  if (!rows.length) return 0;
  const known = new Map<NetworkId, Set<string>>();
  let marked = 0;
  for (const t of rows) {
    if (t.direction !== 'in' || t.category !== 'auto' || !t.counterparty || t.amount === '0') continue;
    const value = await usdValue(t);
    if (value === null || value >= DUST_USD) continue;
    let set = known.get(t.network);
    if (!set) known.set(t.network, (set = knownAddresses(t.network)));
    if (!imitatedAddress(t.counterparty, set, true)) continue;
    transfers.markSpam(t.id);
    if (!t.note) transfers.setNote(t.id, POISONING_NOTE);
    marked++;
  }
  setSetting(CHECKED_KEY, rows[rows.length - 1]!.id);
  if (marked) log.info(`hid ${marked} address-poisoning dust transfer(s)`);
  return marked;
}
