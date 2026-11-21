import { AttachmentBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { ASSETS, isAssetId } from '../../core/assets.ts';
import { getConfig } from '../../config.ts';
import { transfers } from '../../db/repo.ts';
import { buildPortfolio } from '../../portfolio/portfolio.ts';
import { flowReport, transactionsCsv } from '../../portfolio/reports.ts';
import { plural } from '../../util/format.ts';
import { localDay, PERIOD_CHOICES, periodRange, type Period } from '../../util/time.ts';
import { autocompleteWallet, COIN_CHOICES, defer, fail, findWallet, infoEmbed, respond, type Command } from '../common.ts';
import { flowReportEmbed } from '../embeds/portfolio.ts';
import { safe } from '../theme.ts';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function report(i: ChatInputCommandInteraction): Promise<void> {
  const period = (i.options.getString('period') ?? 'this_month') as Period;
  const walletInput = i.options.getString('wallet');
  const w = walletInput ? findWallet(walletInput) : undefined;
  if (walletInput && !w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  await defer(i);
  const range = periodRange(period, getConfig().timezone);
  const r = flowReport(range.from, range.to, w ? { walletId: w.id } : {});
  const title = w ? `Report for ${safe(w.label, 60)}` : 'Income and Activity Report';
  await respond(i, { embeds: [flowReportEmbed(r, title, range.label)] });
}

async function exportTransactions(i: ChatInputCommandInteraction): Promise<void> {
  const period = (i.options.getString('period') ?? 'all') as Period;
  const walletInput = i.options.getString('wallet');
  const w = walletInput ? findWallet(walletInput) : undefined;
  if (walletInput && !w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  const asset = i.options.getString('coin');
  await defer(i);
  const tz = getConfig().timezone;
  const range = periodRange(period, tz);
  const rows = transfers.range({
    ...(w ? { walletId: w.id } : {}),
    ...(asset && isAssetId(asset) ? { asset } : {}),
    ...(period !== 'all' ? { from: range.from, to: range.to } : {}),
    includeIgnored: true,
  });
  if (!rows.length) return fail(i, 'No transactions match these filters.', 'Nothing to Export');
  const csv = transactionsCsv(rows);
  const name = `transactions-${w ? w.label.replace(/[^\w-]+/g, '_') + '-' : ''}${asset ?? 'all'}-${period}-${localDay(tz)}.csv`;
  const file = new AttachmentBuilder(Buffer.from('﻿' + csv, 'utf8'), { name });
  await respond(i, {
    embeds: [
      infoEmbed(
        'Transactions Export',
        `${plural(rows.length, 'transaction')} exported (${range.label}). Dates are UTC; values are USD at the time of each transaction. Opens in Excel or Google Sheets.`,
      ),
    ],
    files: [file],
  });
}

async function exportPortfolio(i: ChatInputCommandInteraction): Promise<void> {
  await defer(i);
  const p = await buildPortfolio();
  const header = [
    'asset',
    'name',
    'quantity',
    'price_usd',
    'value_usd',
    'allocation_pct',
    'avg_buy_price_usd',
    'cost_basis_usd',
    'unrealized_pnl_usd',
    'unrealized_pnl_pct',
    'realized_pnl_usd',
    'fees_usd',
  ];
  const lines = [header.join(',')];
  for (const h of p.holdings) {
    lines.push(
      [
        h.asset,
        ASSETS[h.asset].name,
        h.qty,
        h.price ?? '',
        h.value.toFixed(2),
        h.allocationPct.toFixed(2),
        h.avgCost ?? '',
        h.costBasis?.toFixed(2) ?? '',
        h.unrealized?.toFixed(2) ?? '',
        h.unrealizedPct?.toFixed(2) ?? '',
        h.realized.toFixed(2),
        h.book?.feesUsd.toFixed(2) ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  lines.push(
    [
      'TOTAL',
      '',
      '',
      '',
      p.totalValue.toFixed(2),
      '100',
      '',
      p.costBasis.toFixed(2),
      p.unrealized.toFixed(2),
      '',
      p.realized.toFixed(2),
      p.feesUsd.toFixed(2),
    ].join(','),
  );
  const file = new AttachmentBuilder(Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8'), {
    name: `portfolio-${localDay(getConfig().timezone)}.csv`,
  });
  await respond(i, {
    embeds: [infoEmbed('Portfolio Export', `${plural(p.holdings.length, 'holding')} exported with current prices.`)],
    files: [file],
  });
}

export const reportCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Money in and out, payments received, fees and realized P/L for a period')
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Time range (default: this month)')
        .addChoices(...PERIOD_CHOICES),
    )
    .addStringOption((o) => o.setName('wallet').setDescription('Only this wallet').setAutocomplete(true)),
  execute: report,
  autocomplete: autocompleteWallet,
};

export const exportCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('export')
    .setDescription('Download your data as CSV (Excel / Google Sheets)')
    .addSubcommand((s) =>
      s
        .setName('transactions')
        .setDescription('All transactions with USD values, fees and categories')
        .addStringOption((o) =>
          o
            .setName('period')
            .setDescription('Time range (default: all time)')
            .addChoices(...PERIOD_CHOICES),
        )
        .addStringOption((o) => o.setName('wallet').setDescription('Only this wallet').setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('coin')
            .setDescription('Only this coin')
            .addChoices(...COIN_CHOICES),
        ),
    )
    .addSubcommand((s) => s.setName('portfolio').setDescription('Current holdings with average price and P/L')),
  async execute(i) {
    if (i.options.getSubcommand() === 'portfolio') await exportPortfolio(i);
    else await exportTransactions(i);
  },
  autocomplete: autocompleteWallet,
};
