import { detectAddress, type AddressCandidate } from '../core/address.ts';
import { EVM_NETWORKS, isEvmNetwork, isNetworkId, NETWORKS, type NetworkId } from '../core/networks.ts';
import { walletNetworks, wallets, type WalletRow } from '../db/repo.ts';
import { createLogger, redact } from '../logger.ts';
import { tracker } from '../tracker/tracker.ts';

const log = createLogger('wallets');

export const LABEL_RE = /^[\p{L}\p{N} _.\-#()&']{1,40}$/u;
export const LABEL_RULES = "Labels can be up to 40 characters: letters, numbers, spaces and - _ . # ( ) & '";

/** "auto" = detect; "evm" = all EVM networks; or an explicit list of networks. */
export type NetworkHint = 'auto' | 'evm' | NetworkId[];

const ALIASES: Record<string, NetworkId[] | 'evm'> = {
  bitcoin: ['bitcoin'],
  btc: ['bitcoin'],
  litecoin: ['litecoin'],
  ltc: ['litecoin'],
  evm: 'evm',
  'all-evm': 'evm',
  all: 'evm',
  ethereum: ['ethereum'],
  eth: ['ethereum'],
  erc20: ['ethereum'],
  bsc: ['bsc'],
  bnb: ['bsc'],
  bep20: ['bsc'],
  'bnb-chain': ['bsc'],
  'bnb-smart-chain': ['bsc'],
  polygon: ['polygon'],
  matic: ['polygon'],
  pol: ['polygon'],
  base: ['base'],
  solana: ['solana'],
  sol: ['solana'],
  spl: ['solana'],
  xrp: ['xrp'],
  ripple: ['xrp'],
};

/** Parses "bsc, base" / "evm" / "litecoin" into a hint; null when a name is unknown. */
export function parseNetworkHint(text: string): NetworkHint | null {
  const parts = text
    .split(/[\s,;+/]+/)
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);
  if (!parts.length) return 'auto';
  const nets = new Set<NetworkId>();
  for (const p of parts) {
    const a = ALIASES[p] ?? (isNetworkId(p) ? [p] : undefined);
    if (!a) return null;
    if (a === 'evm') EVM_NETWORKS.forEach((n) => nets.add(n));
    else a.forEach((n) => nets.add(n));
  }
  return [...nets];
}

export interface WalletPlan {
  candidate: AddressCandidate;
  networks: NetworkId[];
}

export type PlanResult =
  | { ok: true; plan: WalletPlan }
  | { ok: false; kind: 'secret' | 'invalid' | 'ambiguous' | 'mismatch'; message: string; options?: string[] };

/**
 * Validates an address and decides which networks to track.
 * `fallback` only breaks ties (e.g. a "3..." address valid on both Bitcoin and Litecoin).
 */
export function planWallet(address: string, hint: NetworkHint = 'auto', fallback: NetworkId[] | null = null): PlanResult {
  const d = detectAddress(address);
  if (d.kind === 'secret') return { ok: false, kind: 'secret', message: d.reason };
  if (d.kind !== 'address') return { ok: false, kind: 'invalid', message: d.reason };

  let candidates = d.candidates;
  if (hint === 'evm') candidates = candidates.filter((c) => c.family === 'evm');
  else if (Array.isArray(hint)) candidates = candidates.filter((c) => c.networks.some((n) => hint.includes(n)));
  if (!candidates.length) return { ok: false, kind: 'mismatch', message: 'The address does not belong to the network you selected.' };
  if (candidates.length > 1 && fallback) {
    const narrowed = candidates.filter((c) => c.networks.some((n) => fallback.includes(n)));
    if (narrowed.length === 1) candidates = narrowed;
  }
  if (candidates.length > 1) {
    const preferred = candidates.filter((c) => c.preferred);
    if (preferred.length === 1) candidates = preferred;
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous',
      message: 'This address format is valid on more than one network.',
      options: candidates.map((c) => c.description),
    };
  }
  const c = candidates[0]!;
  let networks: NetworkId[];
  if (c.family !== 'evm') networks = c.networks;
  else if (Array.isArray(hint)) networks = hint.filter((n) => isEvmNetwork(n));
  else networks = [...EVM_NETWORKS];
  if (!networks.length) return { ok: false, kind: 'mismatch', message: 'That network does not match an EVM (0x...) address.' };
  return { ok: true, plan: { candidate: c, networks } };
}

/** The wallet already tracking this address (same address and family), if any. */
export function findExisting(c: AddressCandidate): WalletRow | undefined {
  return wallets.byAddress(c.address).find((w) => w.family === c.family);
}

export function autoLabel(c: AddressCandidate): string {
  const prefix = c.family === 'evm' ? 'EVM' : NETWORKS[c.networks[0]!].shortName;
  const a = c.address;
  return `${prefix} ${a.slice(0, a.startsWith('0x') ? 6 : 5)}..${a.slice(-4)}`.slice(0, 40);
}

/** Returns a label that is not used yet ("Label", "Label 2", ...). */
export function uniqueLabel(label: string): string {
  if (!wallets.byLabel(label)) return label;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${label.slice(0, 36)} ${n}`;
    if (!wallets.byLabel(candidate)) return candidate;
  }
  return `${label.slice(0, 30)} ${Date.now() % 100000}`;
}

/** Addresses currently being set up (prevents duplicates from parallel adds). */
const inProgress = new Set<string>();

export function isBeingAdded(address: string): boolean {
  return inProgress.has(address.toLowerCase());
}

export interface NetworkFailure {
  network: NetworkId;
  error: string;
}

/** Starts tracking networks for a wallet. Each network fetches its starting point and balance. */
async function addNetworksTo(
  walletId: number,
  address: string,
  label: string,
  nets: NetworkId[],
): Promise<{ added: NetworkId[]; failed: NetworkFailure[] }> {
  const added: NetworkId[] = [];
  const failed: NetworkFailure[] = [];
  for (const n of nets) {
    try {
      await tracker.addWalletNetwork(walletId, n, address);
      added.push(n);
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err));
      log.warn(`could not start tracking ${n} for ${label}: ${msg}`);
      failed.push({ network: n, error: msg });
    }
  }
  return { added, failed };
}

export type CreateResult =
  | { ok: true; wallet: WalletRow; added: NetworkId[]; failed: NetworkFailure[] }
  | { ok: false; reason: 'busy' | 'duplicate' | 'label' | 'unreachable'; message: string; existing?: WalletRow; failed?: NetworkFailure[] };

/** Creates a wallet and starts tracking it (live now, history import queued). */
export async function createTrackedWallet(label: string, plan: WalletPlan): Promise<CreateResult> {
  const c = plan.candidate;
  const key = c.address.toLowerCase();
  if (inProgress.has(key)) return { ok: false, reason: 'busy', message: 'This address is being added right now.' };
  const existing = wallets
    .byAddress(c.address)
    .find(
      (w) =>
        w.family === c.family &&
        (walletNetworks.forWallet(w.id).some((wn) => plan.networks.includes(wn.network)) || walletNetworks.forWallet(w.id).length === 0),
    );
  if (existing) return { ok: false, reason: 'duplicate', message: `This address is already tracked as "${existing.label}".`, existing };
  if (!LABEL_RE.test(label)) return { ok: false, reason: 'label', message: LABEL_RULES };
  if (wallets.byLabel(label)) return { ok: false, reason: 'label', message: `A wallet named "${label}" already exists.` };

  inProgress.add(key);
  try {
    const walletId = wallets.create({ label, address: c.address, family: c.family });
    const { added, failed } = await addNetworksTo(walletId, c.address, label, plan.networks);
    if (!added.length) {
      wallets.remove(walletId);
      return {
        ok: false,
        reason: 'unreachable',
        message: `Could not reach the ${plan.networks.map((n) => NETWORKS[n].name).join(', ')} data providers right now.`,
        failed,
      };
    }
    log.info(`tracking "${label}" on ${added.join(', ')}`);
    return { ok: true, wallet: wallets.get(walletId)!, added, failed };
  } finally {
    inProgress.delete(key);
  }
}

/** Adds networks an existing wallet does not track yet. `busy`: another change to it is still running. */
export async function addMissingNetworks(
  w: WalletRow,
  nets: NetworkId[],
): Promise<{ added: NetworkId[]; failed: NetworkFailure[]; busy?: boolean }> {
  const current = new Set(walletNetworks.forWallet(w.id).map((wn) => wn.network));
  const missing = nets.filter((n) => !current.has(n));
  if (!missing.length) return { added: [], failed: [] };
  const key = w.address.toLowerCase();
  if (inProgress.has(key)) return { added: [], failed: [], busy: true };
  inProgress.add(key);
  try {
    return await addNetworksTo(w.id, w.address, w.label, missing);
  } finally {
    inProgress.delete(key);
  }
}
