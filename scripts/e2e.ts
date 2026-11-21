/**
 * End-to-end check of the whole pipeline against live public APIs, without Discord:
 * add wallets on every network -> history import -> live poll -> pricing -> portfolio ->
 * render every embed type and validate Discord limits -> CSV.
 *
 *   node scripts/e2e.ts            (uses a temporary database; never touches data/)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbedBuilder } from 'discord.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-e2e-'));
process.env.DATABASE_PATH = join(dir, 'e2e.db');
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

const { getConfig } = await import('../src/config.ts');
const { setLogLevel, registerSecret } = await import('../src/logger.ts');
const { openDb, closeDb } = await import('../src/db/database.ts');
const { wallets, walletNetworks, transfers } = await import('../src/db/repo.ts');
const { tracker } = await import('../src/tracker/tracker.ts');
const { backfills } = await import('../src/tracker/backfill.ts');
const { notifier } = await import('../src/tracker/notifier.ts');
const { priceBacklog } = await import('../src/tracker/pricing.ts');
const { buildPortfolio } = await import('../src/portfolio/portfolio.ts');
const { flowReport, transactionsCsv } = await import('../src/portfolio/reports.ts');
const { getPriceService } = await import('../src/prices/prices.ts');
const { detectAddress } = await import('../src/core/address.ts');
const { NETWORKS } = await import('../src/core/networks.ts');
const { transferEmbed, catchUpEmbed, importFinishedEmbed } = await import('../src/discord/embeds/notifications.ts');
const P = await import('../src/discord/embeds/portfolio.ts');
const { closeHttp } = await import('../src/util/http.ts');

const cfg = getConfig();
setLogLevel(cfg.logLevel);
registerSecret(cfg.etherscanApiKey);
openDb(cfg.databasePath);

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
};

/** Discord embed limits. */
function validEmbed(e: EmbedBuilder, name: string): void {
  const j = e.toJSON();
  const problems: string[] = [];
  if ((j.title?.length ?? 0) > 256) problems.push('title > 256');
  if ((j.description?.length ?? 0) > 4096) problems.push('description > 4096');
  if ((j.fields?.length ?? 0) > 25) problems.push('more than 25 fields');
  let total = (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0) + (j.author?.name.length ?? 0);
  for (const f of j.fields ?? []) {
    if (f.name.length > 256 || f.name.length === 0) problems.push(`field name length ${f.name.length}`);
    if (f.value.length > 1024 || f.value.length === 0) problems.push(`field "${f.name}" value length ${f.value.length}`);
    total += f.name.length + f.value.length;
  }
  if (total > 6000) problems.push(`total ${total} > 6000`);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(j))) problems.push('contains emoji');
  check(problems.length === 0, `embed ${name}${problems.length ? ': ' + problems.join(', ') : ''}`);
}

const sent: string[] = [];
/** Notifications that would be wrong: imported history, or activity confirmed before tracking began. */
const badNotices: string[] = [];
const outbox = {
  async transfer(n: Parameters<typeof transferEmbed>[0]) {
    validEmbed(transferEmbed(n), `live notice (${n.kind})`);
    const t = n.transfer;
    sent.push(`${n.kind} ${t.network} ${t.direction} ${t.txid.slice(0, 12)}`);
    const before = t.block_time !== null && t.block_time < n.wallet.tracking_since - 120;
    if (t.backfilled || before)
      badNotices.push(
        `${t.network} ${t.txid} (backfilled=${t.backfilled}, block_time=${t.block_time}, tracking_since=${n.wallet.tracking_since})`,
      );
    return true;
  },
  async catchUp(w: never, items: never[]) {
    validEmbed(catchUpEmbed(w, items), 'catch-up');
    return true;
  },
  async priceAlert() {
    return true;
  },
  async dailySummary() {
    return true;
  },
  async importFinished(n: Parameters<typeof importFinishedEmbed>[0]) {
    validEmbed(importFinishedEmbed(n), `import finished (${n.wallet.label} ${n.wallet.network})`);
    return true;
  },
};
notifier.setOutbox(outbox as never);
backfills.setOutbox(outbox as never);

const WALLETS: Array<{ label: string; address: string; network?: string }> = [
  { label: 'BTC small', address: 'bc1q3v93q22sjrdsljxkmc4rnqnzy7ngh3gy59km5m' },
  { label: 'LTC small', address: 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9' },
  { label: 'EVM small', address: '0x56be729e2fa75ff7953361828c1ead303c7c55f1' },
  { label: 'SOL small', address: '3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ' },
  { label: 'XRP payments', address: 'rLQFZ2FFMjHoxSDWbbJneWneTVMNXjFLas' },
];

const t0 = Date.now();
for (const w of WALLETS) {
  const d = detectAddress(w.address);
  if (d.kind !== 'address') {
    check(false, `detect ${w.label}`);
    continue;
  }
  const c = d.candidates[0]!;
  const id = wallets.create({ label: w.label, address: c.address, family: c.family });
  for (const n of c.networks) {
    try {
      await tracker.addWalletNetwork(id, n, c.address);
      check(true, `track ${w.label} on ${n}`);
    } catch (err) {
      check(false, `track ${w.label} on ${n}: ${(err as Error).message}`);
    }
  }
}

// Wait for history imports (bounded).
const deadline = Date.now() + 8 * 60_000;
while (Date.now() < deadline) {
  const all = walletNetworks.all();
  const busy = all.filter((w) => w.backfill_status === 'pending' || w.backfill_status === 'running');
  if (!busy.length) break;
  await new Promise((r) => setTimeout(r, 3000));
}
for (const wn of walletNetworks.all()) {
  check(
    wn.backfill_status === 'done',
    `history import ${wn.label} on ${wn.network}: ${wn.backfill_status}${wn.backfill_error ? ' ' + wn.backfill_error : ''} (${transfers.countForWalletNetwork(wn.id)} rows)`,
  );
}
console.log(`imports took ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// One live poll per wallet network.
tracker.start();
for (const wn of walletNetworks.all()) {
  await tracker.pollNow(wn.id);
  const after = walletNetworks.get(wn.id)!;
  check(after.consecutive_errors === 0, `live poll ${wn.label} on ${wn.network}${after.last_error ? ': ' + after.last_error : ''}`);
}
tracker.stop();

while ((await priceBacklog(400)) > 0) {
  /* drain */
}
check(transfers.countUnpriced() === 0, `all transfers priced (unpriced: ${transfers.countUnpriced()})`);
check(
  badNotices.length === 0,
  `no notifications for imported or pre-tracking history${badNotices.length ? ': ' + badNotices.join('; ') : ''}`,
);
console.log(`live notifications during the run (real new activity): ${sent.join(', ') || 'none'}`);

// Portfolio and reconciliation (ledger quantity vs live balance per coin).
const p = await buildPortfolio();
console.log(`portfolio value $${p.totalValue.toFixed(2)}, ${p.holdings.length} holdings, P/L ${p.totalPnl.toFixed(2)}`);
for (const h of p.holdings) {
  const tol = Math.max(1e-8, h.qty * 1e-9);
  check(Math.abs(h.discrepancy) <= tol, `${h.asset}: live ${h.qty} vs history ${h.book?.qty ?? 0} (diff ${h.discrepancy})`);
}

validEmbed(P.overviewEmbed(p), 'portfolio overview');
validEmbed(P.byWalletEmbed(p), 'portfolio by wallet');
validEmbed(P.byNetworkEmbed(p), 'portfolio by network');
for (const h of p.holdings) validEmbed(P.coinEmbed(h.asset, h, p.quotes.get(h.asset), p), `coin ${h.asset}`);
validEmbed(P.pricesEmbed(await getPriceService().getQuotes()), 'prices');
const r = flowReport(0, Math.floor(Date.now() / 1000) + 1);
validEmbed(P.flowReportEmbed(r, 'Income and Activity Report', 'All time'), 'report');
validEmbed(
  P.dailySummaryEmbed(p, undefined, flowReport(Math.floor(Date.now() / 1000) - 86400, Math.floor(Date.now() / 1000) + 1)),
  'daily summary',
);

// Render a Seen and a Confirmed notice for one real transfer of every network.
for (const wn of walletNetworks.all()) {
  const rows = transfers.list({ walletId: wn.wallet_id, network: wn.network }, 1, 0);
  const t = rows[0];
  if (!t) continue;
  for (const kind of ['seen', 'confirmed'] as const) {
    validEmbed(
      transferEmbed({
        kind,
        transfer: t,
        wallet: wn,
        confirmations: 1,
        required: NETWORKS[wn.network].confirmations,
        priceUsd: t.price_usd,
        valueUsd: t.price_usd !== null ? (Number(t.amount) / 10 ** t.decimals) * t.price_usd : null,
        feeUsd: 0.01,
        etaSec: 150,
        timeTakenSec: 266,
        balanceAfter: { amount: '1.5', usd: 100 },
        warning: null,
      }),
      `${kind} notice for ${wn.network}`,
    );
  }
}

const csv = transactionsCsv(transfers.range({ includeIgnored: true }));
check(csv.split('\r\n').length > 2, `CSV export (${csv.split('\r\n').length - 2} rows)`);

await closeHttp();
closeDb();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows may hold the WAL file briefly */
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
