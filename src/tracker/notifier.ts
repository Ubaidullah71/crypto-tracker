import { getAdapter } from '../chains/index.ts';
import { formatUnits, toNumber } from '../core/amount.ts';
import { NETWORKS } from '../core/networks.ts';
import { balances, transfers, walletNetworks, type TransferRow, type WalletNetworkJoined } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import { effectivePrice } from '../portfolio/portfolio.ts';
import { getSettings, requiredConfirmations, type AppSettings } from '../settings.ts';
import { nowSec } from '../util/async.ts';
import type { Destination, NoticeKind, Outbox, TransferNotice } from './outbox.ts';
import { imitatedAddress, knownAddresses, markPoisoningDust } from './poisoning.ts';

const log = createLogger('notifier');

/** Above this many new live transfers in one poll (e.g. after downtime), send one summary instead. */
const CATCH_UP_THRESHOLD = 6;
/** Keep retrying a failed delivery (Discord outage, missing permissions) for this long. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
/** A "Seen" message that could not be delivered quickly is pointless; move on to "Confirmed". */
const SEEN_STALE_AFTER_MS = 10 * 60 * 1000;

export function walletDestination(wn: WalletNetworkJoined, s: AppSettings): Destination {
  return { channelId: wn.notify_channel_id ?? s.notifyChannelId, mention: s.mentionOwner };
}

function meta(t: TransferRow): Record<string, unknown> {
  try {
    return t.meta ? (JSON.parse(t.meta) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function confirmationsOf(t: TransferRow, tip: number | null): number {
  if (t.status !== 'confirmed') return 0;
  if (t.block_height === null || tip === null) return 1;
  return Math.max(1, tip - t.block_height + 1);
}

/** True when the transaction counts as final for "Transaction Confirmed". */
export function isFinal(t: TransferRow, tip: number | null, required: number): boolean {
  if (t.status !== 'confirmed') return false;
  const family = NETWORKS[t.network].family;
  if (family === 'solana' || family === 'xrp') return true;
  return confirmationsOf(t, tip) >= required;
}

/** Warning for an incoming transfer from an address that imitates one of your own or a recipient's. */
function poisoningWarning(t: TransferRow, wn: WalletNetworkJoined): string | null {
  if (t.direction !== 'in' || !t.counterparty) return null;
  if (!imitatedAddress(t.counterparty, knownAddresses(wn.network))) return null;
  return 'The sender address imitates one of your known addresses (same start and end). This is a common address-poisoning scam. Never copy addresses from your transaction history.';
}

export class Notifier {
  private outbox: Outbox | null = null;
  /** First failed delivery time per "<transferId>:<kind>". */
  private readonly firstFailure = new Map<string, number>();
  /** Transfers of a catch-up summary that could not be delivered yet, per wallet network. */
  private readonly pendingCatchUp = new Map<number, { ids: Set<number>; since: number }>();

  setOutbox(o: Outbox): void {
    this.outbox = o;
  }

  /** Evaluates every live transfer of a wallet network and sends whatever is due. */
  async process(wnId: number, tip: number | null, newIds: number[] = []): Promise<void> {
    const wn = walletNetworks.get(wnId);
    if (!wn || !this.outbox) return;
    await markPoisoningDust().catch((e) => log.warn('address-poisoning check failed', e));
    const s = getSettings();
    const rows = transfers.needingNotification(wnId);
    if (!rows.length) return;
    const dest = walletDestination(wn, s);

    const eligible: TransferRow[] = [];
    for (const t of rows) {
      const reason = this.skipReason(t, wn, s);
      if (reason) {
        transfers.markNotifySkipped(t.id);
        log.debug(`skip notification ${t.txid} (${reason})`);
      } else eligible.push(t);
    }

    // Flood protection: many brand-new transfers at once -> one catch-up message. If it cannot be
    // delivered (Discord reconnecting), the summary is retried instead of sending each one.
    const pending = this.pendingCatchUp.get(wnId);
    const fresh = eligible.filter((t) => (newIds.includes(t.id) || pending?.ids.has(t.id)) && !t.notified_seen_at);
    if (fresh.length > CATCH_UP_THRESHOLD || (pending && fresh.length > 0)) {
      const items = fresh.map((t) => transfers.get(t.id)).filter((x): x is NonNullable<typeof x> => !!x);
      const ok = await this.outbox.catchUp(wn, items, dest).catch((e) => (log.warn('catch-up send failed', e), false));
      const since = pending?.since ?? Date.now();
      if (ok || Date.now() - since > GIVE_UP_AFTER_MS) {
        if (!ok) log.warn(`giving up on a catch-up summary of ${fresh.length} transfers for ${wn.label} on ${wn.network}`);
        for (const t of fresh) transfers.markNotifySkipped(t.id);
        this.pendingCatchUp.delete(wnId);
      } else {
        this.pendingCatchUp.set(wnId, { ids: new Set(fresh.map((t) => t.id)), since });
      }
      return;
    }
    if (pending) this.pendingCatchUp.delete(wnId);

    const required = requiredConfirmations(wn.network, s);
    for (const t of eligible) {
      let kind: NoticeKind | null = null;
      if (t.status === 'dropped') {
        if (t.notified_seen_at && !t.notified_dropped_at) kind = 'dropped';
        else {
          transfers.markNotifySkipped(t.id);
          continue;
        }
      } else if (t.status === 'failed') {
        kind = 'failed';
      } else if (isFinal(t, tip, required)) {
        kind = 'confirmed';
      } else if (!t.notified_seen_at && s.notifySeen) {
        kind = 'seen';
      }
      if (!kind) continue;
      await this.send(kind, t, wn, tip, required, dest);
    }
  }

  private skipReason(t: TransferRow, wn: WalletNetworkJoined, s: AppSettings): string | null {
    if (!wn.notify_enabled) return 'wallet notifications off';
    if (t.direction === 'self') return 'self transfer';
    if (t.amount === '0') return 'fee only';
    if (t.category === 'ignored') return 'ignored';
    if (t.direction === 'in' && !s.notifyIncoming) return 'incoming off';
    if (t.direction === 'out' && !s.notifyOutgoing) return 'outgoing off';
    if (t.first_seen_at < wn.tracking_since) return 'before tracking started';
    const price = effectivePrice(t);
    if (price !== null && s.minNotifyUsd > 0) {
      const value = toNumber(BigInt(t.amount), t.decimals) * price;
      if (value < s.minNotifyUsd) return `below minimum (${value.toFixed(4)} USD)`;
    }
    return null;
  }

  private async send(
    kind: NoticeKind,
    t: TransferRow,
    wn: WalletNetworkJoined,
    tip: number | null,
    required: number,
    dest: Destination,
  ): Promise<void> {
    if (!this.outbox) return;
    const key = `${t.id}:${kind}`;
    const full = transfers.get(t.id);
    if (!full) return;
    const net = NETWORKS[t.network];
    const price = effectivePrice(t);
    const qty = toNumber(BigInt(t.amount), t.decimals);
    const feeUsd = t.fee && t.fee_price_usd !== null ? toNumber(BigInt(t.fee), net.native.decimals) * t.fee_price_usd : null;
    const m = meta(t);

    let etaSec: number | null = null;
    if (kind === 'seen') {
      if (net.family === 'utxo' && typeof m.feeRate === 'number') {
        etaSec =
          (await getAdapter(t.network)
            .estimateConfirmationSeconds?.(m.feeRate)
            .catch(() => null)) ?? null;
      } else if (net.family === 'evm') {
        etaSec = Math.max(1, required - confirmationsOf(t, tip)) * net.blockTimeSec;
      } else if (net.family === 'solana') {
        etaSec = 13;
      }
    }

    let balanceAfter: TransferNotice['balanceAfter'] = null;
    const bal = balances.forWalletNetwork(wn.id).find((b) => b.asset_key === t.asset_key);
    if (bal) {
      const amt = formatUnits(BigInt(bal.amount), t.decimals);
      balanceAfter = { amount: amt, usd: price !== null ? Number(amt) * price : null };
    }

    const notice: TransferNotice = {
      kind,
      transfer: full,
      wallet: wn,
      confirmations: confirmationsOf(t, tip),
      required,
      priceUsd: price,
      valueUsd: price !== null ? qty * price : null,
      feeUsd,
      etaSec,
      timeTakenSec:
        kind === 'confirmed' && t.notified_seen_at
          ? Math.max(
              0,
              (net.family === 'utxo' && t.block_time && t.block_time >= t.first_seen_at ? t.block_time : nowSec()) - t.first_seen_at,
            )
          : null,
      balanceAfter,
      warning: poisoningWarning(t, wn),
    };

    let ok = false;
    try {
      ok = await this.outbox.transfer(notice, dest);
    } catch (err) {
      log.warn(`failed to deliver ${kind} notification for ${t.txid}`, err);
    }
    if (ok) {
      this.firstFailure.delete(key);
      if (kind === 'seen') transfers.markNotified(t.id, 'seen');
      else if (kind === 'dropped') {
        transfers.markNotified(t.id, 'dropped');
        transfers.markNotifySkipped(t.id);
      } else transfers.markNotified(t.id, 'confirmed');
      return;
    }
    const first = this.firstFailure.get(key) ?? Date.now();
    this.firstFailure.set(key, first);
    const age = Date.now() - first;
    if (kind === 'seen' && age > SEEN_STALE_AFTER_MS) {
      // Stop retrying the unconfirmed message only; the "Confirmed" one is still sent later.
      log.warn(`could not deliver the "seen" notification for ${t.txid}; will send the confirmation instead`);
      transfers.markNotified(t.id, 'seen');
      this.firstFailure.delete(key);
    } else if (age > GIVE_UP_AFTER_MS) {
      log.error(`giving up on the ${kind} notification for ${t.txid} after 24h of failed deliveries`);
      transfers.markNotifySkipped(t.id);
      this.firstFailure.delete(key);
    }
  }
}

export const notifier = new Notifier();
