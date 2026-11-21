import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder, type EmbedBuilder } from 'discord.js';
import { ASSETS, isAssetId, type AssetId } from '../../core/assets.ts';
import { buildPortfolio, type Portfolio } from '../../portfolio/portfolio.ts';
import { getPriceService } from '../../prices/prices.ts';
import { COIN_CHOICES, defer, fail, respond, type Command } from '../common.ts';
import { byNetworkEmbed, byWalletEmbed, coinEmbed, overviewEmbed, pricesEmbed } from '../embeds/portfolio.ts';

type View = 'overview' | 'wallets' | 'networks';

function render(p: Portfolio, view: View): EmbedBuilder {
  return view === 'wallets' ? byWalletEmbed(p) : view === 'networks' ? byNetworkEmbed(p) : overviewEmbed(p);
}

function controls(p: Portfolio, view: View): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
  // Three short buttons fit on one line on phones. The highlighted (current) view refreshes itself.
  const btn = (id: View, label: string) =>
    new ButtonBuilder()
      .setCustomId(view === id ? `pf:refresh:${id}` : `pf:view:${id}`)
      .setLabel(label)
      .setStyle(view === id ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn('overview', 'Overview'),
      btn('wallets', 'Wallets'),
      btn('networks', 'Networks'),
    ),
  ];
  const held = p.holdings.filter((h) => h.value >= 0.01 || Math.abs(h.realized) >= 0.01);
  if (held.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('pf:coin')
          .setPlaceholder('Open coin details')
          .addOptions(held.slice(0, 25).map((h) => ({ label: `${ASSETS[h.asset].name} (${h.asset})`, value: h.asset }))),
      ),
    );
  }
  return rows;
}

async function coinView(asset: AssetId, p?: Portfolio): Promise<EmbedBuilder> {
  const portfolio = p ?? (await buildPortfolio());
  const quote = portfolio.quotes.get(asset) ?? (await getPriceService().getQuote(asset)) ?? undefined;
  return coinEmbed(
    asset,
    portfolio.holdings.find((h) => h.asset === asset),
    quote,
    portfolio,
  );
}

export const portfolioCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('Total value, holdings, average buy price and profit/loss')
    .addStringOption((o) =>
      o
        .setName('view')
        .setDescription('What to show')
        .addChoices(
          { name: 'Overview', value: 'overview' },
          { name: 'By wallet', value: 'wallets' },
          { name: 'By network', value: 'networks' },
        ),
    ),
  async execute(i) {
    await defer(i);
    const view = (i.options.getString('view') ?? 'overview') as View;
    const p = await buildPortfolio();
    await respond(i, { embeds: [render(p, view)], components: controls(p, view) });
  },
  components: {
    async pf(i, args) {
      const [action, arg] = args;
      if (action === 'coin' && i.isStringSelectMenu()) {
        const asset = i.values[0];
        if (!asset || !isAssetId(asset)) return;
        await i.deferUpdate();
        const p = await buildPortfolio();
        const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('pf:view:overview').setLabel('Back').setStyle(ButtonStyle.Secondary),
        );
        await i.editReply({ embeds: [await coinView(asset, p)], components: [back] });
        return;
      }
      if ((action === 'view' || action === 'refresh') && i.isButton()) {
        await i.deferUpdate();
        const view = (['overview', 'wallets', 'networks'].includes(arg ?? '') ? arg : 'overview') as View;
        const p = await buildPortfolio({ forceQuotes: action === 'refresh' });
        await i.editReply({ embeds: [render(p, view)], components: controls(p, view) });
      }
    },
  },
};

export const coinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('coin')
    .setDescription('Details for one coin: holdings, average buy price, P/L, networks, activity')
    .addStringOption((o) =>
      o
        .setName('coin')
        .setDescription('Coin')
        .setRequired(true)
        .addChoices(...COIN_CHOICES),
    ),
  async execute(i) {
    const asset = i.options.getString('coin', true);
    if (!isAssetId(asset)) return fail(i, 'Unknown coin.');
    await defer(i);
    await respond(i, { embeds: [await coinView(asset)] });
  },
};

export const priceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('price')
    .setDescription('Current market prices')
    .addStringOption((o) =>
      o
        .setName('coin')
        .setDescription('Show one coin in detail')
        .addChoices(...COIN_CHOICES),
    ),
  async execute(i) {
    await defer(i);
    const asset = i.options.getString('coin');
    if (asset && isAssetId(asset)) {
      await respond(i, { embeds: [await coinView(asset)] });
      return;
    }
    await respond(i, { embeds: [pricesEmbed(await getPriceService().getQuotes())] });
  },
};
