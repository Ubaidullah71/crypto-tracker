import { NETWORKS, type NetworkId } from './core/networks.ts';
import { getSetting, setSetting } from './db/repo.ts';

export interface AppSettings {
  /** Default channel for notifications; null = DM the owners. */
  notifyChannelId: string | null;
  notifyIncoming: boolean;
  notifyOutgoing: boolean;
  /** Send the "Transaction Seen" (unconfirmed) alert before the "Confirmed" one. */
  notifySeen: boolean;
  /** Skip notifications below this USD value (dust / spam). */
  minNotifyUsd: number;
  /** Mention the owner(s) in channel notifications so phones ping. */
  mentionOwner: boolean;
  /** Command replies in servers are only visible to you. */
  privateReplies: boolean;
  summaryEnabled: boolean;
  /** "HH:MM" in the configured time zone. */
  summaryTime: string;
  /** null = same destination as notifications. */
  summaryChannelId: string | null;
  /** null = same destination as notifications. */
  alertsChannelId: string | null;
  /** Per-network confirmation overrides. */
  confirmations: Partial<Record<NetworkId, number>>;
  /** Post a message when a wallet's history import finishes. */
  importNotices: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  notifyChannelId: null,
  notifyIncoming: true,
  notifyOutgoing: true,
  notifySeen: true,
  minNotifyUsd: 0.1,
  mentionOwner: false,
  privateReplies: true,
  summaryEnabled: true,
  summaryTime: '09:00',
  summaryChannelId: null,
  alertsChannelId: null,
  confirmations: {},
  importNotices: true,
};

const KEY = 'app';

export function getSettings(): AppSettings {
  const stored = getSetting<Partial<AppSettings>>(KEY) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored, confirmations: { ...stored.confirmations } };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  setSetting(KEY, next);
  return next;
}

/** One-time upgrades of stored settings when defaults change between versions. */
export function migrateSettings(): void {
  const version = getSetting<number>('settingsVersion') ?? 1;
  // Stored choices are never overridden; this only records the settings format version.
  if (version < 2) setSetting('settingsVersion', 2);
}

export function requiredConfirmations(network: NetworkId, s: AppSettings = getSettings()): number {
  return Math.max(1, s.confirmations[network] ?? NETWORKS[network].confirmations);
}
