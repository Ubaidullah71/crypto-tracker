import { basename } from 'node:path';
import type { EmbedBuilder } from 'discord.js';
import type { NetworkId } from '../../core/networks.ts';
import type { WalletFileReport } from '../../wallets/file.ts';
import { ASSETS } from '../../core/assets.ts';
import { formatUnits } from '../../core/amount.ts';
import { getNetworkAsset, NETWORKS } from '../../core/networks.ts';
import type { TransferWithWallet, WalletNetworkJoined } from '../../db/repo.ts';
import type { ImportNotice, TransferNotice } from '../../tracker/outbox.ts';
import { coin, duration, plural, ts, usd } from '../../util/format.ts';
import { addressLink, assetTitle, base, coinIcon, COLORS, fieldValue, footer, safe, txLink, usdAndCoin } from '../theme.ts';

function parseMeta(json: string | null): Record<string, unknown> {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function feeRateText(network: TransferWithWallet['network'], m: Record<string, unknown>): string {
  const rate = m.feeRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'n/a';
  const unit = NETWORKS[network].feeRateUnit;
  const digits = rate >= 100 ? 0 : rate >= 1 ? 2 : 4;
  return `${rate.toFixed(digits)} ${unit}`;
}

/** The "Transaction Seen / Confirmed" embeds, modeled on the reference design. */
export function transferEmbed(n: TransferNotice): EmbedBuilder {
  const t = n.transfer;
  const net = NETWORKS[t.network];
  const na = getNetworkAsset(t.asset_key);
  const sym = na?.label ?? ASSETS[t.asset].symbol;
  const m = parseMeta(t.meta);
  const incoming = t.direction === 'in';
  const label = `**${safe(t.label, 80)}**`;

  let color: number = COLORS.success;
  let title = '';
  let description = '';
  switch (n.kind) {
    case 'seen':
      color = COLORS.pending;
      title = incoming ? 'Transaction Seen' : 'Outgoing Transaction Seen';
      description =
        net.family === 'evm'
          ? `${label} ${incoming ? 'received' : 'sent'} a transaction that is waiting for confirmations (${n.confirmations} of ${n.required}).`
          : incoming
            ? `Your wallet ${label} is receiving an unconfirmed transaction.`
            : `Your wallet ${label} is sending an unconfirmed transaction.`;
      break;
    case 'confirmed':
      color = incoming ? COLORS.success : COLORS.outgoing;
      title = incoming ? 'Transaction Confirmed' : 'Outgoing Transaction Confirmed';
      description = incoming
        ? `A transaction being sent to your wallet ${label} has confirmed.`
        : `A transaction sent from your wallet ${label} has confirmed.`;
      break;
    case 'dropped':
      color = COLORS.danger;
      title = 'Transaction Dropped';
      description = `An unconfirmed transaction for ${label} is no longer in the mempool. It was most likely replaced (RBF) or expired. No funds moved.`;
      break;
    case 'failed':
      color = COLORS.danger;
      title = 'Transaction Failed';
      description = `A transaction from ${label} failed on-chain. Only the network fee was spent.`;
      break;
  }

  const e = base(color)
    .setAuthor({ name: assetTitle(t.asset_key), iconURL: coinIcon(t.asset) })
    .setTitle(title)
    .setDescription(description);

  const ownAddress = typeof m.ownAddress === 'string' ? m.ownAddress : null;
  e.addFields({
    name: 'Address',
    value: ownAddress ? `${addressLink(t.network, ownAddress)}\n${addressLink(t.network, t.address)}` : addressLink(t.network, t.address),
  });
  if (m.syntheticTxid) {
    e.addFields({
      name: 'Transaction',
      value: `Internal transfer in block ${t.block_height ?? 'n/a'} (contract call; no direct transaction hash)`,
    });
  } else {
    e.addFields({ name: 'Transaction ID', value: txLink(t.network, t.txid) });
  }

  // Status row
  if (n.kind === 'seen') {
    if (net.family === 'utxo') {
      e.addFields(
        { name: 'Time Seen', value: ts(t.first_seen_at, 'f'), inline: true },
        { name: 'ETA', value: n.etaSec !== null ? `~${duration(n.etaSec)}` : 'Unknown', inline: true },
        { name: 'RBF', value: m.rbf === true ? 'Yes (replaceable)' : m.rbf === false ? 'No' : 'n/a', inline: true },
      );
    } else {
      e.addFields(
        { name: 'Time Seen', value: ts(t.first_seen_at, 'f'), inline: true },
        { name: 'Confirmations', value: `${n.confirmations} of ${n.required}`, inline: true },
        { name: 'ETA', value: n.etaSec !== null ? `~${duration(n.etaSec)}` : 'Unknown', inline: true },
      );
    }
  } else if (n.kind === 'confirmed' || n.kind === 'failed') {
    const confirmedAt = net.family === 'utxo' && t.block_time ? t.block_time : Math.floor(Date.now() / 1000);
    e.addFields(
      { name: n.kind === 'failed' ? 'Failed At' : 'Confirmed At', value: ts(confirmedAt, 'f'), inline: true },
      { name: 'Time Taken', value: n.timeTakenSec !== null ? duration(n.timeTakenSec) : 'n/a', inline: true },
      {
        name: net.family === 'xrp' ? 'Ledger' : net.family === 'solana' ? 'Slot' : 'Block',
        value: t.block_height !== null ? t.block_height.toLocaleString('en-US') : 'n/a',
        inline: true,
      },
    );
  }

  // Amount row
  const amt = formatUnits(BigInt(t.amount), t.decimals);
  const feeCoin = t.fee !== null ? formatUnits(BigInt(t.fee), net.native.decimals) : null;
  e.addFields(
    { name: 'Amount', value: usdAndCoin(n.valueUsd !== null ? usd(n.valueUsd) : 'n/a', coin(amt, sym)), inline: true },
    {
      name: t.charge_fee || !incoming ? 'Fee (paid by you)' : 'Fee',
      value: feeCoin !== null ? usdAndCoin(n.feeUsd !== null ? usd(n.feeUsd) : 'n/a', coin(feeCoin, net.native.asset)) : 'n/a',
      inline: true,
    },
    { name: 'Fee Rate', value: feeRateText(t.network, m), inline: true },
  );

  // Context row
  const extra: Array<{ name: string; value: string; inline: boolean }> = [];
  if (t.counterparty) {
    extra.push({ name: incoming ? 'From' : 'To', value: addressLink(t.network, t.counterparty, true), inline: true });
  }
  if (typeof m.destinationTag === 'number') extra.push({ name: 'Destination Tag', value: String(m.destinationTag), inline: true });
  if (n.kind === 'confirmed' && n.balanceAfter) {
    extra.push({
      name: 'Wallet Balance',
      value: `${coin(n.balanceAfter.amount, sym)}${n.balanceAfter.usd !== null ? `\n(${usd(n.balanceAfter.usd)} USD)` : ''}`,
      inline: true,
    });
  }
  if (n.priceUsd !== null && n.kind !== 'dropped') {
    extra.push({ name: `${ASSETS[t.asset].symbol} Price`, value: `${usd(n.priceUsd)} USD`, inline: true });
  }
  if (extra.length) e.addFields(...extra.slice(0, 3));

  if (n.warning) e.addFields({ name: 'Security Warning', value: fieldValue(n.warning) });

  return footer(e, `Wallet: ${t.label}  |  ${net.name}`).setTimestamp(new Date());
}

/** One message summarizing many transfers detected at once (e.g. after the bot was offline). */
export function catchUpEmbed(wallet: WalletNetworkJoined, items: TransferWithWallet[]): EmbedBuilder {
  const lines = items.slice(0, 15).map((t) => {
    const na = getNetworkAsset(t.asset_key);
    const sym = na?.label ?? t.asset;
    const dir = t.direction === 'in' ? 'Received' : 'Sent';
    const v = t.price_usd !== null ? ` (${usd(Number(formatUnits(BigInt(t.amount), t.decimals)) * t.price_usd)})` : '';
    return `${ts(t.block_time ?? t.first_seen_at, 'd')}  ${dir} ${coin(formatUnits(BigInt(t.amount), t.decimals), sym)}${v}  ${txLink(t.network, t.txid, true)}`;
  });
  if (items.length > 15) lines.push(`...and ${items.length - 15} more. Use /transactions to see everything.`);
  const e = base(COLORS.brand)
    .setTitle('Activity Catch-Up')
    .setDescription(
      `${plural(items.length, 'new transaction')} were found for **${safe(wallet.label, 80)}** on ${NETWORKS[wallet.network].name} at once, so they are summarized here instead of one message each.\n\n${lines.join('\n')}`,
    );
  return footer(e, `Wallet: ${wallet.label}`).setTimestamp(new Date());
}

export function walletFileEmbed(r: WalletFileReport): EmbedBuilder {
  const file = basename(r.path);
  const e = base(r.problems.length ? COLORS.warning : COLORS.success).setTitle('Wallet File Synced');
  if (!r.exists) {
    e.setDescription(
      `**${file}** does not exist yet. It is created with instructions when the bot starts; add one \`Label = address\` per line and save.`,
    );
    return footer(e).setTimestamp(new Date());
  }
  e.setDescription(
    `Read ${plural(r.entries, 'wallet')} from **${file}**.` +
      (r.added.length ? ' New wallets are live now; their history is importing in the background.' : ''),
  );
  const nets = (n: NetworkId[]) => n.map((x) => NETWORKS[x].name).join(', ');
  const fields: Array<{ name: string; value: string }> = [];
  if (r.added.length)
    fields.push({
      name: `Added (${r.added.length})`,
      value: fieldValue(r.added.map((a) => `**${safe(a.label, 60)}**: ${nets(a.networks)}`).join('\n')),
    });
  const updates = [
    ...r.extended.map((x) => `**${safe(x.label, 60)}**: now also on ${nets(x.networks)}`),
    ...r.renamed.map((x) => `**${safe(x.from, 60)}** renamed to **${safe(x.to, 60)}**`),
  ];
  if (updates.length) fields.push({ name: 'Updated', value: fieldValue(updates.join('\n')) });
  if (r.problems.length) {
    fields.push({
      name: `Needs Attention (${r.problems.length})`,
      value: fieldValue(r.problems.map((p) => `Line ${p.line}: ${safe(p.message, 220)}`).join('\n')),
    });
  }
  if (r.unchanged) fields.push({ name: 'Unchanged', value: plural(r.unchanged, 'wallet') });
  if (r.notInFile.length) {
    fields.push({
      name: 'Tracked but Not in the File',
      value: fieldValue(`${r.notInFile.map((l) => safe(l, 40)).join(', ')}\nThese are kept. Use \`/wallet remove\` to stop tracking one.`),
    });
  }
  for (const f of fields) e.addFields(f);
  return footer(e, file).setTimestamp(new Date());
}

export function importFinishedEmbed(n: ImportNotice): EmbedBuilder {
  const net = NETWORKS[n.wallet.network];
  if (n.error) {
    return footer(
      base(COLORS.warning)
        .setTitle('History Import Stopped')
        .setDescription(
          `The history import for **${safe(n.wallet.label, 80)}** on ${net.name} stopped after finding ${plural(n.transfers, 'transaction')}.\n\nReason: ${safe(n.error, 300)}\n\nLive tracking is not affected. Run \`/wallet reimport\` to try again.`,
        ),
      `Wallet: ${n.wallet.label}`,
    ).setTimestamp(new Date());
  }
  if (n.capped) {
    return footer(
      base(COLORS.warning)
        .setTitle('History Import Limit Reached')
        .setDescription(
          `The history import for **${safe(n.wallet.label, 80)}** on ${net.name} stopped at the limit of ${plural(n.capped, 'transaction')} (${plural(n.transfers, 'transaction')} stored). Older history is incomplete, so profit/loss for this wallet is not reliable.\n\nLive tracking is not affected. To import everything, raise \`MAX_HISTORY_TRANSACTIONS\` in \`.env\`, restart and run \`/wallet reimport\`.`,
        ),
      `Wallet: ${n.wallet.label}`,
    ).setTimestamp(new Date());
  }
  return footer(
    base(COLORS.success)
      .setTitle('History Import Complete')
      .setDescription(
        `Imported ${plural(n.transfers, 'transaction')} for **${safe(n.wallet.label, 80)}** on ${net.name} in ${duration(n.durationSec)}. Historical prices are being filled in, so portfolio profit/loss will settle in a few minutes.`,
      ),
    `Wallet: ${n.wallet.label}`,
  ).setTimestamp(new Date());
}
