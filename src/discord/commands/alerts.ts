import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { ASSETS, isAssetId } from '../../core/assets.ts';
import { alerts } from '../../db/repo.ts';
import { getPriceService } from '../../prices/prices.ts';
import { getSettings } from '../../settings.ts';
import { pct, price, ts, usdShort } from '../../util/format.ts';
import { COIN_CHOICES, defer, fail, respond, successEmbed, type Command } from '../common.ts';
import { base, COLORS, fieldValue, footer, safe } from '../theme.ts';
import { table } from '../../util/table.ts';

const MAX_ALERTS = 50;

async function add(i: ChatInputCommandInteraction): Promise<void> {
  const asset = i.options.getString('coin', true);
  const condition = i.options.getString('when', true) as 'above' | 'below';
  const target = i.options.getNumber('price', true);
  const repeat = i.options.getBoolean('repeat') ?? false;
  const note = i.options.getString('note');
  if (!isAssetId(asset)) return fail(i, 'Unknown coin.');
  if (!(target > 0) || target > 1e9) return fail(i, 'Enter a positive price.', 'Invalid Price');
  if (alerts.list().length >= MAX_ALERTS)
    return fail(i, `You can have up to ${MAX_ALERTS} active alerts. Remove some with \`/alert remove\`.`, 'Too Many Alerts');
  await defer(i);
  const current = await getPriceService().getPrice(asset);
  const lastState = current === null ? null : current >= target ? 'above' : 'below';
  const id = alerts.create({ asset, condition, target, repeat, lastState, note: note?.trim().slice(0, 200) || null });
  const already = lastState === condition;
  const s = getSettings();
  const dest = s.alertsChannelId ?? s.notifyChannelId;
  const e = successEmbed(
    'Price Alert Created',
    `You will be notified when **${ASSETS[asset].name}** goes **${condition} ${price(target)}**.${
      already
        ? `\n\nIt is already ${condition} that price (${price(current)}), so the alert fires the next time it crosses ${condition} it again.`
        : ''
    }`,
  );
  e.addFields(
    { name: 'Alert ID', value: String(id), inline: true },
    { name: 'Current Price', value: price(current), inline: true },
    { name: 'Distance', value: current ? pct(((target - current) / current) * 100) : 'n/a', inline: true },
    { name: 'Repeat', value: repeat ? 'Yes, every time it crosses' : 'No, once', inline: true },
    { name: 'Delivered To', value: dest ? `<#${dest}>` : 'Your DMs', inline: true },
  );
  await respond(i, { embeds: [e] });
}

async function list(i: ChatInputCommandInteraction): Promise<void> {
  await defer(i);
  const quotes = await getPriceService().getQuotes();
  const rows = alerts.list(true);
  const e = base(COLORS.brand).setTitle('Price Alerts');
  if (!rows.length) {
    e.setDescription('No alerts yet. Create one with `/alert add`.');
    return respond(i, { embeds: [footer(e)] });
  }
  const active = rows.filter((a) => a.active);
  const done = rows.filter((a) => !a.active);
  const alertTable = (list: typeof rows) =>
    table(
      [{ header: 'ID', align: 'right' }, { header: 'COIN' }, { header: 'WHEN' }, { header: 'AWAY', align: 'right' }],
      list.map((a) => {
        const cur = quotes.get(a.asset)?.price ?? null;
        return [
          String(a.id),
          a.asset,
          `${a.condition} ${a.target >= 1000 ? usdShort(a.target) : price(a.target)}`,
          cur ? pct(((a.target - cur) / cur) * 100, 1) : 'n/a',
        ];
      }),
    );
  const details = (list: typeof rows) =>
    list
      .filter((a) => a.repeat || a.note || a.triggered_at)
      .map((a) => {
        const parts = [
          a.repeat ? 'repeats' : '',
          a.triggered_at ? `last fired ${ts(a.triggered_at, 'R')}` : '',
          a.note ? safe(a.note, 100) : '',
        ].filter(Boolean);
        return `**${a.id}**: ${parts.join(', ')}`;
      })
      .join('\n');
  if (active.length) {
    const d = details(active);
    e.addFields({ name: `Active (${active.length})`, value: fieldValue(alertTable(active) + (d ? `\n${d}` : '')) });
  }
  if (done.length) e.addFields({ name: 'Already Triggered', value: fieldValue(alertTable(done.slice(0, 10))) });
  await respond(i, { embeds: [footer(e, 'Remove one with /alert remove id:<number>')] });
}

async function remove(i: ChatInputCommandInteraction): Promise<void> {
  const id = i.options.getInteger('id', true);
  const a = alerts.get(id);
  if (!a) return fail(i, `There is no alert #${id}.`, 'Not Found');
  alerts.remove(id);
  await respond(i, { embeds: [successEmbed('Alert Removed', `Alert #${id} (${a.asset} ${a.condition} ${price(a.target)}) was removed.`)] });
}

export const alertCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('alert')
    .setDescription('Price alerts')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Get notified when a coin crosses a price')
        .addStringOption((o) =>
          o
            .setName('coin')
            .setDescription('Coin')
            .setRequired(true)
            .addChoices(...COIN_CHOICES),
        )
        .addStringOption((o) =>
          o
            .setName('when')
            .setDescription('Direction')
            .setRequired(true)
            .addChoices({ name: 'Goes above', value: 'above' }, { name: 'Drops below', value: 'below' }),
        )
        .addNumberOption((o) => o.setName('price').setDescription('Price in USD').setRequired(true).setMinValue(0))
        .addBooleanOption((o) => o.setName('repeat').setDescription('Fire every time the price crosses (default: once)'))
        .addStringOption((o) => o.setName('note').setDescription('Optional reminder text').setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show your price alerts'))
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete a price alert')
        .addIntegerOption((o) => o.setName('id').setDescription('Alert ID from /alert list').setRequired(true).setMinValue(1)),
    ),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'add') await add(i);
    else if (sub === 'list') await list(i);
    else await remove(i);
  },
};
