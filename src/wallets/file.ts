import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { sameAddress } from '../core/address.ts';
import { NETWORKS, type NetworkId } from '../core/networks.ts';
import { getConfig } from '../config.ts';
import { wallets } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import {
  addMissingNetworks,
  autoLabel,
  createTrackedWallet,
  findExisting,
  LABEL_RE,
  LABEL_RULES,
  parseNetworkHint,
  planWallet,
  uniqueLabel,
  type NetworkHint,
  type WalletPlan,
} from './manage.ts';

const log = createLogger('wallet-file');

/**
 * wallets.txt: list your addresses once and the bot keeps tracking them in sync.
 *
 *   # comment
 *   [Bitcoin]                       optional section (only used to tell BTC/LTC "3..." addresses apart)
 *   Main BTC = bc1q...              label = address
 *   bc1q...                         label is generated
 *   Trading = 0xabc... @ bsc, base  limit an EVM address to some networks (default: all four)
 *
 * Lines removed from the file are NOT deleted from the bot (history is kept); use /wallet remove.
 */
export const TEMPLATE = `# =====================================================================
#  MY WALLETS
#
#  ONE LINE = ONE ADDRESS.   Format:   Any Name = address
#
#  - Add as many lines as you want, for any coin, in any order.
#    Two LTC addresses? Two LTC lines. Three Solana wallets? Three lines.
#  - The name before "=" is yours to choose. Lines with the same name (one
#    wallet app with several coins, e.g. "Exodus") get the chain added:
#    Exodus BTC, Exodus LTC, Exodus EVM, Exodus SOL ...
#  - The coin/network is detected from the address automatically.
#  - Replace each PASTE-...-HERE with a real PUBLIC address, then save.
#    The bot picks it up within seconds and posts a "Wallet File Synced" message.
#  - Lines you do not need: delete them, or leave PASTE-...-HERE (ignored).
#  - Lines starting with # are notes. The headings below are only for tidiness.
#  - Only PUBLIC addresses. Never a private key or recovery phrase.
# =====================================================================


# ---- Bitcoin (BTC) ---------------------------------------------------
BTC Main          = PASTE-BTC-ADDRESS-HERE
BTC Savings       = PASTE-BTC-ADDRESS-HERE


# ---- Litecoin (LTC) --------------------------------------------------
LTC Main          = PASTE-LTC-ADDRESS-HERE
LTC Payments      = PASTE-LTC-ADDRESS-HERE


# ---- Ethereum, BNB Chain, Polygon, Base (0x... addresses) ------------
# ONE 0x address already covers ETH, BNB (BEP20), POL, Base ETH and
# USDT / USDC on all four networks, so list each 0x address only once.
# Different 0x addresses (e.g. MetaMask and Trust Wallet) = different lines.
#
# Optional: watch only some networks by adding "@" and network names:
#   Binance Deposit = 0x... @ bsc
#   Base Wallet     = 0x... @ base, ethereum
MetaMask          = PASTE-0x-ADDRESS-HERE
Trust Wallet EVM  = PASTE-0x-ADDRESS-HERE


# ---- Solana (SOL, USDT, USDC) ----------------------------------------
Phantom           = PASTE-SOLANA-ADDRESS-HERE
Solflare          = PASTE-SOLANA-ADDRESS-HERE


# ---- XRP -------------------------------------------------------------
XRP Main          = PASTE-XRP-ADDRESS-HERE


# ---- Ledger / Trezor / Electrum accounts (xpub) -----------------------
# One account key (xpub / ypub / zpub / Ltub) tracks EVERY address of that
# BTC or LTC account, including new receive and change addresses.
# Ledger Live: Accounts > your account > wrench icon (Edit account) > Advanced > xpub.
# A Litecoin key that starts with "xpub" needs "@ litecoin" at the end.
Ledger BTC        = PASTE-XPUB-HERE
Ledger LTC        = PASTE-XPUB-HERE @ litecoin


# =====================================================================
#  Notes
#  - The same address on two lines is reported and only the first line
#    is used (one address = one wallet in the bot).
#  - Removing a line later does NOT delete the wallet or its history in
#    the bot. To stop tracking one, use /wallet remove in Discord.
#  - Changing a name here renames that wallet in the bot.
#  - Network names for "@": bitcoin, litecoin, ethereum, bsc, polygon,
#    base, solana, xrp, evm (= all four EVM networks).
# =====================================================================
`;

export interface WalletFileEntry {
  line: number;
  label: string | null;
  address: string;
  hint: NetworkHint;
  section: NetworkId[] | null;
}

export interface WalletFileProblem {
  line: number;
  message: string;
}

/**
 * Names for the file's lines. A name used on several lines (one wallet app holding several coins,
 * e.g. "Exodus") gets the chain added to each: "Exodus BTC", "Exodus LTC", "Exodus EVM".
 */
export function fileLabels(items: ReadonlyArray<{ label: string | null; networks: readonly NetworkId[] }>): Array<string | null> {
  const key = (s: string) => s.toLowerCase();
  const count = new Map<string, number>();
  for (const it of items) if (it.label) count.set(key(it.label), (count.get(key(it.label)) ?? 0) + 1);
  const used = new Set(items.filter((it) => it.label && count.get(key(it.label)) === 1).map((it) => key(it.label!)));
  return items.map((it) => {
    if (!it.label || count.get(key(it.label)) === 1) return it.label;
    const tag = it.networks.length === 1 ? NETWORKS[it.networks[0]!].shortName : 'EVM';
    const base = `${it.label.slice(0, 40 - tag.length - 1).trimEnd()} ${tag}`;
    let name = base;
    for (let n = 2; used.has(key(name)); n++) name = `${base.slice(0, 40 - String(n).length - 1).trimEnd()} ${n}`;
    used.add(key(name));
    return name;
  });
}

export function isPlaceholder(address: string): boolean {
  return /^PASTE[-_]/i.test(address) || /[-_]HERE$/i.test(address) || /^<.*>$/.test(address);
}

export function walletFilePath(): string {
  return getConfig().walletsFile;
}

/** Pure parser. Never includes the raw text of a line in problems (it might be a secret). */
export function parseWalletFile(text: string): { entries: WalletFileEntry[]; problems: WalletFileProblem[] } {
  const entries: WalletFileEntry[] = [];
  const problems: WalletFileProblem[] = [];
  let section: NetworkId[] | null = null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    const s = raw.trim();
    if (!s || s.startsWith('#') || s.startsWith('//') || s.startsWith(';')) return;
    const sec = /^\[(.+)\]$/.exec(s);
    if (sec) {
      const h = parseNetworkHint(sec[1]!);
      section = Array.isArray(h) ? h : null;
      return;
    }
    // Inline comment: " # ..." (a "#" followed by a space or the end). "Wallet #2" stays a name.
    const noComment = s.replace(/\s#(\s.*)?$/, '').trim();
    let label: string | null = null;
    let rest = noComment;
    const sep = /[=|:]/.exec(noComment);
    if (sep && sep.index > 0) {
      label = noComment.slice(0, sep.index).trim() || null;
      rest = noComment.slice(sep.index + 1).trim();
    }
    // Inline comments are allowed after the address.
    const hashAt = rest.indexOf('#');
    if (hashAt >= 0) rest = rest.slice(0, hashAt).trim();
    const parenAt = rest.search(/\s\(/);
    if (parenAt >= 0) rest = rest.slice(0, parenAt).trim();
    let hint: NetworkHint = 'auto';
    const at = rest.indexOf('@');
    let address = rest;
    if (at >= 0) {
      address = rest.slice(0, at).trim();
      const h = parseNetworkHint(rest.slice(at + 1));
      if (h === null) {
        problems.push({
          line,
          message: 'Unknown network after "@". Use bitcoin, litecoin, ethereum, bsc, polygon, base, solana, xrp or evm.',
        });
        return;
      }
      hint = h;
    }
    if (!address) {
      problems.push({ line, message: 'No address found.' });
      return;
    }
    // Unfilled sample lines ("PASTE-BTC-ADDRESS-HERE", "<address>") are ignored quietly.
    if (isPlaceholder(address)) return;
    if (/\s/.test(address) && address.split(/\s+/).length >= 12) {
      problems.push({
        line,
        message: 'This looks like a recovery (seed) phrase. It was ignored and not stored. Delete it from the file now.',
      });
      return;
    }
    if (/\s/.test(address)) {
      problems.push({ line, message: 'Expected "Label = address" (one address per line).' });
      return;
    }
    if (label && !LABEL_RE.test(label)) {
      problems.push({ line, message: LABEL_RULES });
      return;
    }
    entries.push({ line, label, address, hint, section });
  });
  return { entries, problems };
}

export interface WalletFileReport {
  path: string;
  exists: boolean;
  entries: number;
  added: Array<{ label: string; networks: NetworkId[] }>;
  extended: Array<{ label: string; networks: NetworkId[] }>;
  renamed: Array<{ from: string; to: string }>;
  unchanged: number;
  problems: WalletFileProblem[];
  notInFile: string[];
}

export function reportHasChanges(r: WalletFileReport): boolean {
  return r.added.length > 0 || r.extended.length > 0 || r.renamed.length > 0 || r.problems.length > 0;
}

let running: Promise<WalletFileReport> | null = null;
let lastHash: string | null = null;

/** Creates the commented template when the file does not exist yet. */
export function ensureWalletFile(): void {
  const path = walletFilePath();
  if (existsSync(path)) return;
  try {
    writeFileSync(path, TEMPLATE, { encoding: 'utf8', mode: 0o600 });
    log.info(`created ${path}; add your wallet addresses there`);
  } catch (err) {
    log.warn(`could not create ${path}`, err);
  }
}

/** True when an address appears in the wallets file (used to warn before /wallet remove). */
export function walletFileHasAddress(address: string): boolean {
  try {
    const { entries } = parseWalletFile(readFileSync(walletFilePath(), 'utf8'));
    return entries.some((e) => sameAddress(e.address, address));
  } catch {
    return false;
  }
}

let followUp: Promise<WalletFileReport> | null = null;

/**
 * Reads the wallets file and starts tracking anything new. Serialized: when a sync is already
 * running (adding wallets can take a while), one follow-up run re-reads the file afterwards so
 * a save made in the meantime is never lost.
 */
export function syncWalletFile(): Promise<WalletFileReport> {
  if (!running) {
    running = doSync().finally(() => {
      running = null;
    });
    return running;
  }
  followUp ??= running
    .catch(() => undefined)
    .then(() => {
      followUp = null;
      return syncWalletFile();
    });
  return followUp;
}

async function doSync(): Promise<WalletFileReport> {
  const path = walletFilePath();
  const report: WalletFileReport = {
    path,
    exists: existsSync(path),
    entries: 0,
    added: [],
    extended: [],
    renamed: [],
    unchanged: 0,
    problems: [],
    notInFile: [],
  };
  if (!report.exists) return report;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    report.problems.push({ line: 0, message: `Could not read the file: ${(err as Error).message}` });
    return report;
  }
  lastHash = createHash('sha256').update(text).digest('hex');
  const { entries, problems } = parseWalletFile(text);
  report.problems.push(...problems);
  report.entries = entries.length;
  /** "<family>:<normalized address>" -> first line. One address = one wallet. */
  const seenAddresses = new Map<string, number>();

  const valid: Array<{ e: WalletFileEntry; plan: WalletPlan }> = [];
  for (const e of entries) {
    const planned = planWallet(e.address, e.hint, e.section);
    if (!planned.ok) {
      const msg =
        planned.kind === 'secret'
          ? `${planned.message} It was ignored and not stored. Delete it from the file now.`
          : planned.kind === 'ambiguous'
            ? `${planned.message} Add "@ bitcoin" or "@ litecoin" after the address.`
            : planned.message;
      report.problems.push({ line: e.line, message: msg });
      continue;
    }
    const { candidate } = planned.plan;
    const addrKey = `${candidate.family}:${/^0x/i.test(candidate.address) || /^(bc1|ltc1)/i.test(candidate.address) ? candidate.address.toLowerCase() : candidate.address}`;
    const firstLine = seenAddresses.get(addrKey);
    if (firstLine !== undefined) {
      const tip = candidate.family === 'evm' ? ' To watch several networks, list it once, e.g. "@ bsc, base".' : '';
      report.problems.push({ line: e.line, message: `Same address as line ${firstLine}; only line ${firstLine} is used.${tip}` });
      continue;
    }
    seenAddresses.set(addrKey, e.line);
    valid.push({ e, plan: planned.plan });
  }
  const labels = fileLabels(valid.map((v) => ({ label: v.e.label, networks: v.plan.networks })));

  for (const [i, { e: entry, plan }] of valid.entries()) {
    const e = { ...entry, label: labels[i] ?? null };
    const { candidate, networks } = plan;
    const netSig = [...networks].sort().join(',');
    const existing = findExisting(candidate);
    if (existing) {
      // Only act on what changed in the file since it was last applied, so a later
      // /wallet rename or /wallet networks is not silently undone.
      let changed = false;
      let fileLabel = existing.file_label;
      if (e.label && e.label !== existing.file_label) {
        if (e.label === existing.label) {
          fileLabel = e.label;
        } else {
          const other = wallets.byLabel(e.label);
          if (other && other.id !== existing.id) {
            report.problems.push({
              line: e.line,
              message: `Cannot rename "${existing.label}" to "${e.label}": another wallet already uses that name.`,
            });
          } else {
            wallets.rename(existing.id, e.label);
            report.renamed.push({ from: existing.label, to: e.label });
            fileLabel = e.label;
            changed = true;
          }
        }
      }
      let fileNetworks = existing.file_networks;
      let failedAny = false;
      if (netSig !== existing.file_networks) {
        const { added, failed, busy } = await addMissingNetworks(existing, networks);
        if (added.length) {
          report.extended.push({ label: e.label ?? existing.label, networks: added });
          changed = true;
        }
        for (const f of failed)
          report.problems.push({
            line: e.line,
            message: `${NETWORKS[f.network].name} could not be started (will retry on next sync): ${f.error.slice(0, 120)}`,
          });
        if (busy)
          report.problems.push({
            line: e.line,
            message: 'This wallet is being changed right now; its new networks are added on the next sync (`/wallet sync`).',
          });
        failedAny = failed.length > 0 || busy === true;
        if (!failedAny) fileNetworks = netSig;
      }
      wallets.setFileState(existing.id, fileLabel, fileNetworks);
      if (!changed && !failedAny) report.unchanged++;
      continue;
    }

    const label = e.label ?? uniqueLabel(autoLabel(candidate));
    if (e.label && wallets.byLabel(e.label)) {
      report.problems.push({ line: e.line, message: `The label "${e.label}" is already used by another wallet.` });
      continue;
    }
    const res = await createTrackedWallet(label, plan);
    if (res.ok) {
      wallets.setFileState(res.wallet.id, e.label ?? res.wallet.label, res.failed.length ? null : netSig);
      report.added.push({ label: res.wallet.label, networks: res.added });
      for (const f of res.failed)
        report.problems.push({
          line: e.line,
          message: `${NETWORKS[f.network].name} could not be started (will retry on next sync): ${f.error.slice(0, 120)}`,
        });
    } else if (res.reason !== 'busy') {
      report.problems.push({ line: e.line, message: res.message + (res.reason === 'unreachable' ? ' Will retry on the next sync.' : '') });
    }
  }

  const inFile = entries.map((e) => e.address);
  report.notInFile = wallets
    .list()
    .filter((w) => !inFile.some((a) => sameAddress(a, w.address)))
    .map((w) => w.label);
  if (reportHasChanges(report)) {
    log.info(
      `wallet file: ${report.added.length} added, ${report.extended.length} extended, ${report.renamed.length} renamed, ${report.problems.length} problem(s)`,
    );
  }
  return report;
}

let watcher: FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

/** Watches the wallets file and re-syncs a few seconds after it is saved. */
export function watchWalletFile(onSynced: (r: WalletFileReport) => void): void {
  const path = walletFilePath();
  const name = basename(path);
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
      if (file && file.toString() !== name) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        let hash: string | null = null;
        try {
          hash = createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
        } catch {
          return;
        }
        if (hash === lastHash) return;
        log.info(`${name} changed; syncing wallets`);
        syncWalletFile()
          .then(onSynced)
          .catch((err) => log.warn('wallet file sync failed', err));
      }, 2_000);
    });
    watcher.on('error', (err) => log.warn('wallet file watcher error', err));
  } catch (err) {
    log.warn(`cannot watch ${path}; changes are picked up at the next start or with /wallet sync`, err);
  }
}

export function stopWatchingWalletFile(): void {
  if (debounce) clearTimeout(debounce);
  watcher?.close();
  watcher = null;
}
