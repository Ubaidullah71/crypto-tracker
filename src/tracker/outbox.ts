import type { AlertRow, TransferWithWallet, WalletNetworkJoined } from '../db/repo.ts';
import type { Quote } from '../prices/prices.ts';
import type { WalletFileReport } from '../wallets/file.ts';

/** Where a message should go. channelId null = DM every owner. */
export interface Destination {
  channelId: string | null;
  mention: boolean;
}

export type NoticeKind = 'seen' | 'confirmed' | 'dropped' | 'failed';

export interface TransferNotice {
  kind: NoticeKind;
  transfer: TransferWithWallet;
  wallet: WalletNetworkJoined;
  confirmations: number;
  required: number;
  priceUsd: number | null;
  valueUsd: number | null;
  feeUsd: number | null;
  /** Seen only: estimated seconds until confirmation. */
  etaSec: number | null;
  /** Confirmed only: seconds between first seen and confirmation. */
  timeTakenSec: number | null;
  /** Wallet balance of this asset after the transaction. */
  balanceAfter: { amount: string; usd: number | null } | null;
  /** Set when the sender looks like an address-poisoning attempt. */
  warning: string | null;
}

export interface ImportNotice {
  wallet: WalletNetworkJoined;
  transfers: number;
  durationSec: number;
  error: string | null;
  /** Set when the import stopped at MAX_HISTORY_TRANSACTIONS (the limit). */
  capped?: number;
}

/**
 * Implemented by the Discord layer. The tracker never touches discord.js directly.
 * Each method returns true when the message was delivered.
 */
export interface Outbox {
  transfer(n: TransferNotice, dest: Destination): Promise<boolean>;
  catchUp(wallet: WalletNetworkJoined, items: TransferWithWallet[], dest: Destination): Promise<boolean>;
  priceAlert(alert: AlertRow, quote: Quote, dest: Destination): Promise<boolean>;
  dailySummary(dest: Destination): Promise<boolean>;
  importFinished(n: ImportNotice, dest: Destination): Promise<boolean>;
  walletFileSynced(r: WalletFileReport, dest: Destination): Promise<boolean>;
}
