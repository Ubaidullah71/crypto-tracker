import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import { ASSETS, isAssetId, type AssetId } from '../../core/assets.ts';
import { formatUnits, toNumber } from '../../core/amount.ts';
import { getNetworkAsset, NETWORKS } from '../../core/networks.ts';
import { getConfig } from '../../config.ts';
import { CATEGORIES, transfers, type Category, type TransferFilter, type TransferWithWallet } from '../../db/repo.ts';
import { CATEGORY_CHOICES_IN, CATEGORY_CHOICES_OUT, categoryLabel } from '../../portfolio/classify.ts';
import { effectivePrice, trackedIndex } from '../../portfolio/portfolio.ts';
import { getPriceService } from '../../prices/prices.ts';
import { coin, plural, price as fmtPrice, ts, usd } from '../../util/format.ts';
import { PERIOD_CHOICES, periodRange, type Period } from '../../util/time.ts';
import {
  autocompleteWallet,
  COIN_CHOICES,
  defer,
  fail,
  findWallet,
  privateFlag,
  replyText,
  respond,
  successEmbed,
  type Command,
  type ComponentInteraction,
} from '../common.ts';
import { transferLine } from '../embeds/portfolio.ts';
import { addressLink, assetTitle, base, coinIcon, COLORS, fieldValue, footer, safe, txLink } from '../theme.ts';

const PAGE_SIZE = 10;

interface ListState {
  page: number;
  walletId: number | null;
  asset: AssetId | null;
  direction: 'in' | 'out' | null;
  period: Period;
}

function encodeState(s: ListState): string {
  return `txl:${s.page}:${s.walletId ?? ''}:${s.asset ?? ''}:${s.direction ?? ''}:${s.period}`;
}

function decodeState(args: string[]): ListState {
  const [page, w, a, d, p] = args;
  return {
    page: Math.max(0, Number(page) || 0),
    walletId: w ? Number(w) : null,
    asset: a && isAssetId(a) ? a : null,
    direction: d === 'in' || d === 'out' ? d : null,
    period: (PERIOD_CHOICES.some((c) => c.value === p) ? p : 'all') as Period,
  };
}

function listView(s: ListState): { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<ButtonBuilder>> } {
  const range = periodRange(s.period, getConfig().timezone);
  const filter: TransferFilter = {
    ...(s.walletId !== null ? { walletId: s.walletId } : {}),
    ...(s.asset ? { asset: s.asset } : {}),
    ...(s.direction ? { direction: s.direction } : {}),
    ...(s.period !== 'all' ? { from: range.from, to: range.to } : {}),
  };
  const total = transfers.count(filter);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(s.page, pages - 1);
  const rows = transfers.list(filter, PAGE_SIZE, page * PAGE_SIZE);
  const tracked = trackedIndex();

  const filters: string[] = [];
  if (s.walletId !== null)
    filters.push(`Wallet: ${safe(rows[0]?.label ?? findWallet(`id:${s.walletId}`)?.label ?? String(s.walletId), 40)}`);
  if (s.asset) filters.push(`Coin: ${s.asset}`);
  if (s.direction) filters.push(s.direction === 'in' ? 'Incoming only' : 'Outgoing only');
  if (s.period !== 'all') filters.push(`Period: ${range.label}`);

  const e = base(COLORS.brand).setTitle('Transactions');
  const body = rows.length
    ? rows.map((t) => transferLine(t, tracked, s.walletId === null)).join('\n\n')
    : 'No transactions match these filters.';
  e.setDescription(`${filters.length ? filters.join(', ') + '\n\n' : ''}${body}`.slice(0, 4000));
  footer(e, `Page ${page + 1} of ${pages}  |  ${plural(total, 'transaction')}  |  /tx view <id> for details`);

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeState({ ...s, page: page - 1 }))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(encodeState({ ...s, page: page + 1 }) + ':n')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1),
  );
  return { embeds: [e], components: [nav] };
}

// --- detail view ---

function parseMeta(t: TransferWithWallet): Record<string, unknown> {
  try {
    return t.meta ? (JSON.parse(t.meta) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function detailEmbed(t: TransferWithWallet): Promise<EmbedBuilder> {
  const tracked = trackedIndex();
  const net = NETWORKS[t.network];
  const na = getNetworkAsset(t.asset_key);
  const sym = na?.label ?? ASSETS[t.asset].symbol;
  const qtyStr = formatUnits(BigInt(t.amount), t.decimals);
  const qty = toNumber(BigInt(t.amount), t.decimals);
  const p = effectivePrice(t);
  const current = await getPriceService().getPrice(t.asset);
  const m = parseMeta(t);
  const color = t.status === 'failed' || t.status === 'dropped' ? COLORS.danger : t.direction === 'in' ? COLORS.success : COLORS.outgoing;

  const e = base(color)
    .setAuthor({ name: assetTitle(t.asset_key), iconURL: coinIcon(t.asset) })
    .setTitle(categoryLabel(t, tracked));
  e.setDescription(`# ${t.direction === 'out' ? '-' : t.direction === 'in' ? '+' : ''}${coin(qtyStr, sym)}`);
  const status = t.status === 'confirmed' ? 'Confirmed' : t.status === 'pending' ? 'Pending' : t.status === 'failed' ? 'Failed' : 'Dropped';
  e.addFields(
    { name: 'Wallet', value: safe(t.label, 80), inline: true },
    { name: 'Network', value: net.name, inline: true },
    { name: 'Status', value: status, inline: true },
    { name: 'Value at the Time', value: p !== null ? usd(qty * p) : 'Price not available yet', inline: true },
    {
      name: 'Price Used',
      value:
        p !== null ? `${fmtPrice(p)}${t.price_override !== null ? ' (set by you)' : t.price_source ? `\n(${t.price_source})` : ''}` : 'n/a',
      inline: true,
    },
    { name: 'Value Now', value: current !== null ? usd(qty * current) : 'n/a', inline: true },
    { name: 'Date', value: ts(t.block_time ?? t.first_seen_at, 'F'), inline: true },
    {
      name: net.family === 'xrp' ? 'Ledger' : net.family === 'solana' ? 'Slot' : 'Block',
      value: t.block_height?.toLocaleString('en-US') ?? 'n/a',
      inline: true,
    },
  );
  if (t.fee) {
    const feeCoin = formatUnits(BigInt(t.fee), net.native.decimals);
    const feeUsd = t.fee_price_usd !== null ? toNumber(BigInt(t.fee), net.native.decimals) * t.fee_price_usd : null;
    e.addFields({
      name: t.charge_fee ? 'Fee (paid by you)' : 'Fee (paid by sender)',
      value: `${coin(feeCoin, net.native.asset)}${feeUsd !== null ? `\n(${usd(feeUsd)})` : ''}`,
      inline: true,
    });
  }
  if (t.spam) {
    e.addFields({
      name: 'Warning: address poisoning',
      value:
        'This dust came from an address made to look like one you use. It is hidden from lists and alerts. Never copy or send to this address.',
    });
  }
  if (t.counterparty) e.addFields({ name: t.direction === 'in' ? 'From' : 'To', value: addressLink(t.network, t.counterparty) });
  e.addFields({
    name: 'Transaction',
    value: m.syntheticTxid ? `Internal contract transfer in block ${t.block_height ?? 'n/a'}` : txLink(t.network, t.txid),
  });
  if (typeof m.destinationTag === 'number') e.addFields({ name: 'Destination Tag', value: String(m.destinationTag), inline: true });
  if (t.note) e.addFields({ name: 'Note', value: safe(t.note, 500) });
  e.addFields({
    name: 'How this counts',
    value: fieldValue(
      'Change the category below if this was a payment, a purchase, a sale, a move between your own wallets, or spam. Set a price if you bought it at a different price than the market price at the time.',
    ),
  });
  return footer(e, `Transfer ID ${t.id}${t.backfilled ? '  |  imported history' : ''}`);
}

function detailComponents(t: TransferWithWallet): Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> {
  const choices = t.direction === 'in' ? CATEGORY_CHOICES_IN : CATEGORY_CHOICES_OUT;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`txd:cat:${t.id}`)
    .setPlaceholder('Change category')
    .addOptions(choices.map((c) => ({ label: c.name, value: c.value, default: c.value === t.category })));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`txd:price:${t.id}`).setLabel('Set Price').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`txd:note:${t.id}`).setLabel('Note').setStyle(ButtonStyle.Secondary),
  );
  if (t.price_override !== null) {
    buttons.addComponents(
      new ButtonBuilder().setCustomId(`txd:clearprice:${t.id}`).setLabel('Market Price').setStyle(ButtonStyle.Secondary),
    );
  }
  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [buttons];
  if (t.direction !== 'self') rows.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  return rows;
}

function pickerView(rows: TransferWithWallet[]): { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<StringSelectMenuBuilder>> } {
  const tracked = trackedIndex();
  const e = base(COLORS.brand)
    .setTitle('Transaction')
    .setDescription(
      `This transaction touched ${plural(rows.length, 'tracked balance')}:\n\n${rows.map((t) => transferLine(t, tracked)).join('\n\n')}`.slice(
        0,
        4000,
      ),
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId('txd:show')
    .setPlaceholder('Open one to view or edit')
    .addOptions(
      rows.slice(0, 25).map((t) => {
        const na = getNetworkAsset(t.asset_key);
        return {
          label:
            `${t.direction === 'in' ? 'In' : t.direction === 'out' ? 'Out' : 'Self'}  ${formatUnits(BigInt(t.amount), t.decimals)} ${na?.label ?? t.asset}`.slice(
              0,
              100,
            ),
          description: `${t.label} on ${NETWORKS[t.network].name}`.slice(0, 100),
          value: String(t.id),
        };
      }),
    );
  return { embeds: [footer(e)], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

function lookup(query: string): TransferWithWallet[] {
  const q = query.trim();
  if (/^\d{1,10}$/.test(q)) {
    const t = transfers.get(Number(q));
    if (t) return [t];
  }
  return transfers.byTxid(q).filter((t) => t.direction !== 'self' || t.amount !== '0');
}

async function txView(i: ChatInputCommandInteraction): Promise<void> {
  const rows = lookup(i.options.getString('id', true));
  if (!rows.length) return fail(i, 'No tracked transaction with that hash or transfer ID.', 'Not Found');
  await defer(i);
  if (rows.length === 1) await respond(i, { embeds: [await detailEmbed(rows[0]!)], components: detailComponents(rows[0]!) });
  else await respond(i, pickerView(rows));
}

async function txEdit(i: ChatInputCommandInteraction): Promise<void> {
  const rows = lookup(i.options.getString('id', true));
  if (!rows.length) return fail(i, 'No tracked transaction with that hash or transfer ID.', 'Not Found');
  const category = i.options.getString('category') as Category | null;
  const priceIn = i.options.getNumber('price');
  const note = i.options.getString('note');
  if (category === null && priceIn === null && note === null)
    return fail(i, 'Choose at least one thing to change: category, price or note.', 'Nothing to Change');
  if (priceIn !== null && new Set(rows.map((r) => r.asset)).size > 1) {
    return fail(i, 'This transaction moved more than one coin. Use `/tx view` and pick the transfer to set its price.', 'Ambiguous');
  }
  if (category && !CATEGORIES.includes(category)) return fail(i, 'Unknown category.');
  await defer(i);
  const changes: string[] = [];
  for (const t of rows) {
    if (category) {
      const allowed = (t.direction === 'in' ? CATEGORY_CHOICES_IN : CATEGORY_CHOICES_OUT).some((c) => c.value === category);
      if (allowed) transfers.setCategory(t.id, category);
    }
    if (priceIn !== null) transfers.setPriceOverride(t.id, priceIn > 0 ? priceIn : null);
    if (note !== null) transfers.setNote(t.id, note.trim() ? note.trim().slice(0, 500) : null);
  }
  if (category) changes.push(`Category set to **${category}** (where it applies)`);
  if (priceIn !== null) changes.push(priceIn > 0 ? `Price set to **${fmtPrice(priceIn)}** per coin` : 'Price reset to the market price');
  if (note !== null) changes.push(note.trim() ? 'Note saved' : 'Note removed');
  const updated = transfers.get(rows[0]!.id)!;
  await respond(i, { embeds: [successEmbed('Transaction Updated', changes.join('\n')), await detailEmbed(updated)] });
}

async function txList(i: ChatInputCommandInteraction): Promise<void> {
  const walletInput = i.options.getString('wallet');
  const w = walletInput ? findWallet(walletInput) : undefined;
  if (walletInput && !w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  const asset = i.options.getString('coin');
  const dir = i.options.getString('direction');
  const state: ListState = {
    page: 0,
    walletId: w?.id ?? null,
    asset: asset && isAssetId(asset) ? asset : null,
    direction: dir === 'in' || dir === 'out' ? dir : null,
    period: (i.options.getString('period') ?? 'all') as Period,
  };
  await defer(i);
  await respond(i, listView(state));
}

async function handleDetail(i: ComponentInteraction, args: string[]): Promise<void> {
  const [action, idText] = args;
  if (action === 'show' && i.isStringSelectMenu()) {
    const t = transfers.get(Number(i.values[0]));
    if (!t) return;
    await i.deferUpdate();
    await i.editReply({ embeds: [await detailEmbed(t)], components: detailComponents(t) });
    return;
  }
  const t = transfers.get(Number(idText));
  if (!t) {
    await replyText(i, 'That transaction no longer exists.');
    return;
  }
  if (action === 'cat' && i.isStringSelectMenu()) {
    const value = i.values[0] as Category;
    const allowed = (t.direction === 'in' ? CATEGORY_CHOICES_IN : CATEGORY_CHOICES_OUT).some((c) => c.value === value);
    if (allowed) transfers.setCategory(t.id, value);
    await i.deferUpdate();
    const updated = transfers.get(t.id)!;
    await i.editReply({ embeds: [await detailEmbed(updated)], components: detailComponents(updated) });
    return;
  }
  if (action === 'clearprice' && i.isButton()) {
    transfers.setPriceOverride(t.id, null);
    await i.deferUpdate();
    const updated = transfers.get(t.id)!;
    await i.editReply({ embeds: [await detailEmbed(updated)], components: detailComponents(updated) });
    return;
  }
  if (action === 'price' && i.isButton()) {
    const modal = new ModalBuilder()
      .setCustomId(`txm:price:${t.id}`)
      .setTitle('Set Price per Coin (USD)')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('price')
            .setLabel(`USD price per ${t.asset} for this transaction`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 61250.50')
            .setRequired(true)
            .setMaxLength(20),
        ),
      );
    await i.showModal(modal);
    return;
  }
  if (action === 'note' && i.isButton()) {
    const input = new TextInputBuilder()
      .setCustomId('note')
      .setLabel('Note (leave empty to remove)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(500);
    if (t.note) input.setValue(t.note);
    await i.showModal(
      new ModalBuilder()
        .setCustomId(`txm:note:${t.id}`)
        .setTitle('Transaction Note')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    );
  }
}

async function handleModal(i: ComponentInteraction, args: string[]): Promise<void> {
  if (!i.isModalSubmit()) return;
  const [action, idText] = args;
  const t = transfers.get(Number(idText));
  if (!t) return;
  if (action === 'price') {
    const raw = i.fields
      .getTextInputValue('price')
      .trim()
      .replace(/[$,\s]/g, '');
    const value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value <= 0 || value > 1e9) {
      await replyText(i, 'Please enter a positive number, for example 61250.50');
      return;
    }
    transfers.setPriceOverride(t.id, value);
  } else if (action === 'note') {
    const note = i.fields.getTextInputValue('note').trim();
    transfers.setNote(t.id, note ? note.slice(0, 500) : null);
  }
  // Acknowledge first: building the embed may need a price lookup (Discord allows 3 seconds).
  if (i.isFromMessage()) await i.deferUpdate();
  else {
    const flags = privateFlag(i);
    await i.deferReply(flags ? { flags } : {});
  }
  const updated = transfers.get(t.id)!;
  await i.editReply({ embeds: [await detailEmbed(updated)], components: detailComponents(updated) });
}

export const transactionsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('transactions')
    .setDescription('Browse transaction history with filters')
    .addStringOption((o) => o.setName('wallet').setDescription('Only this wallet').setAutocomplete(true))
    .addStringOption((o) =>
      o
        .setName('coin')
        .setDescription('Only this coin')
        .addChoices(...COIN_CHOICES),
    )
    .addStringOption((o) =>
      o
        .setName('direction')
        .setDescription('Incoming or outgoing')
        .addChoices({ name: 'Incoming', value: 'in' }, { name: 'Outgoing', value: 'out' }),
    )
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Time range')
        .addChoices(...PERIOD_CHOICES),
    ),
  execute: txList,
  autocomplete: autocompleteWallet,
  components: {
    async txl(i, args) {
      if (!i.isButton()) return;
      await i.deferUpdate();
      await i.editReply(listView(decodeState(args)));
    },
  },
};

export const txCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('tx')
    .setDescription('View or edit a single transaction')
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription('Show full details, and change its category, price or note')
        .addStringOption((o) =>
          o.setName('id').setDescription('Transaction hash, or the transfer ID shown in the footer').setRequired(true).setMaxLength(140),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Change how a transaction counts in your portfolio')
        .addStringOption((o) => o.setName('id').setDescription('Transaction hash or transfer ID').setRequired(true).setMaxLength(140))
        .addStringOption((o) =>
          o
            .setName('category')
            .setDescription('What this transaction was')
            .addChoices(
              { name: 'Default (received / sent)', value: 'auto' },
              { name: 'Payment received (income)', value: 'payment' },
              { name: 'Purchase (bought it)', value: 'purchase' },
              { name: 'Sale (sold it)', value: 'sale' },
              { name: 'Spend (paid for something)', value: 'spend' },
              { name: 'Transfer to or from my own untracked wallet', value: 'transfer' },
              { name: 'Between my tracked wallets', value: 'internal' },
              { name: 'Ignore (spam / not mine)', value: 'ignored' },
            ),
        )
        .addNumberOption((o) =>
          o.setName('price').setDescription('USD price per coin you actually paid or received (0 = market price)').setMinValue(0),
        )
        .addStringOption((o) => o.setName('note').setDescription('A note for your records (empty text removes it)').setMaxLength(500)),
    ),
  async execute(i) {
    if (i.options.getSubcommand() === 'edit') await txEdit(i);
    else await txView(i);
  },
  components: {
    txd: handleDetail,
    txm: handleModal,
  },
};
