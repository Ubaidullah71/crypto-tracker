import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import { getAdapter } from '../../chains/index.ts';
import { formatUnits } from '../../core/amount.ts';
import { EVM_NETWORKS, isNetworkId, NETWORKS, type NetworkId } from '../../core/networks.ts';
import {
  createTrackedWallet,
  isBeingAdded,
  LABEL_RE,
  LABEL_RULES,
  planWallet,
  type NetworkFailure,
  type NetworkHint,
} from '../../wallets/manage.ts';
import { syncWalletFile, walletFileHasAddress, walletFilePath } from '../../wallets/file.ts';
import { transfers, walletNetworks, wallets, type WalletNetworkJoined, type WalletRow } from '../../db/repo.ts';
import { createLogger, redact } from '../../logger.ts';
import { walletBalances } from '../../portfolio/portfolio.ts';
import { getSettings } from '../../settings.ts';
import { backfills, readProgress } from '../../tracker/backfill.ts';
import { tracker } from '../../tracker/tracker.ts';
import { coin, plural, ts, usd } from '../../util/format.ts';
import { autocompleteWallet, defer, fail, findWallet, respond, successEmbed, type Command } from '../common.ts';
import { NET_SHORT, transferLine } from '../embeds/portfolio.ts';
import { ASSETS } from '../../core/assets.ts';
import { isExtendedKey } from '../../core/xpub.ts';
import { qty, usdShort } from '../../util/format.ts';
import { table } from '../../util/table.ts';
import { walletFileEmbed } from '../embeds/notifications.ts';
import { basename } from 'node:path';
import { addressLink, base, COLORS, fieldValue, footer, safe } from '../theme.ts';
import { trackedIndex } from '../../portfolio/portfolio.ts';

const log = createLogger('cmd:wallet');

const NETWORK_OPTION = [
  { name: 'Auto-detect (recommended)', value: 'auto' },
  { name: 'Bitcoin', value: 'bitcoin' },
  { name: 'Litecoin', value: 'litecoin' },
  { name: 'All EVM networks (Ethereum, BNB Chain, Polygon, Base)', value: 'evm' },
  { name: 'Ethereum only', value: 'ethereum' },
  { name: 'BNB Smart Chain only', value: 'bsc' },
  { name: 'Polygon only', value: 'polygon' },
  { name: 'Base only', value: 'base' },
];

export function syncStatus(wn: WalletNetworkJoined): string {
  const p = readProgress(wn.backfill_progress);
  if (wn.backfill_status === 'running') {
    const pctText = p?.fraction !== null && p?.fraction !== undefined ? ` ${Math.floor(p.fraction * 100)}%` : '';
    return `Importing history${pctText} (${plural(p?.found ?? 0, 'transaction')} so far)`;
  }
  if (wn.backfill_status === 'pending') {
    return p?.stage?.startsWith('Retrying') ? `History import: ${p.stage.toLowerCase()}` : 'Waiting to import history';
  }
  if (wn.consecutive_errors >= 3)
    return `Sync problem (${wn.consecutive_errors} failed attempts): ${safe(wn.last_error ?? 'unknown', 120)}`;
  const base = wn.last_poll_ok_at ? `Live, synced ${ts(wn.last_poll_ok_at, 'R')}` : 'Live, starting';
  if (wn.backfill_status === 'error') return `${base}. History import stopped: ${safe(wn.backfill_error ?? 'unknown', 100)}`;
  if (p?.stage?.startsWith('Stopped at')) return `${base}. History incomplete (import limit reached)`;
  return base;
}

function familyLabel(w: WalletRow): string {
  if (isExtendedKey(w.address)) return 'Account key (all addresses)';
  return w.family === 'evm'
    ? 'EVM address'
    : w.family === 'utxo'
      ? 'Address'
      : w.family === 'solana'
        ? 'Solana address'
        : 'XRP Ledger account';
}

/** One short word or two for tables: Live, Import 32%, Queued, Sync issue, Import failed. */
export function shortStatus(wns: WalletNetworkJoined[]): string {
  if (wns.some((wn) => wn.consecutive_errors >= 3)) return 'Sync issue';
  const running = wns.find((wn) => wn.backfill_status === 'running');
  if (running) {
    const f = readProgress(running.backfill_progress)?.fraction;
    return typeof f === 'number' ? `Import ${Math.floor(f * 100)}%` : 'Importing';
  }
  const pending = wns.find((wn) => wn.backfill_status === 'pending');
  if (pending) return readProgress(pending.backfill_progress)?.stage?.startsWith('Retrying') ? 'Retrying' : 'Queued';
  if (wns.some((wn) => wn.backfill_status === 'error')) return 'Import failed';
  return wns.length ? 'Live' : 'Starting';
}

async function walletViewEmbed(w: WalletRow): Promise<EmbedBuilder> {
  const wns = walletNetworks.forWallet(w.id);
  const { items, total } = await walletBalances(w.id);
  const e = base(COLORS.brand).setTitle(safe(w.label, 100));
  const firstNet = wns[0]?.network;
  e.setDescription(
    [
      'Total Value',
      `# ${usd(total)}`,
      firstNet ? addressLink(firstNet, w.address) : safe(w.address),
      `${familyLabel(w)}, added ${ts(w.created_at, 'D')}`,
    ].join('\n'),
  );
  const nonZero = items.filter((b) => b.amount !== 0n);
  const multi = wns.length > 1;
  e.addFields({
    name: 'Balances',
    value: fieldValue(
      nonZero.length
        ? table(
            [
              { header: multi ? 'COIN / NETWORK' : 'COIN', max: 16 },
              { header: 'AMOUNT', align: 'right' },
              { header: 'VALUE', align: 'right' },
            ],
            nonZero.map((b) => [
              multi ? `${b.label} ${NET_SHORT[b.network]}` : b.label,
              qty(Number(formatUnits(b.amount, b.decimals)), ASSETS[b.asset].stablecoin),
              usdShort(b.value),
            ]),
          )
        : 'No balance on any tracked network.',
    ),
  });
  e.addFields({
    name: 'Sync',
    value: fieldValue(
      wns
        .map((wn) => `**${NET_SHORT[wn.network]}**: ${syncStatus(wn)}, ${plural(transfers.countForWalletNetwork(wn.id), 'transaction')}`)
        .join('\n'),
    ),
  });
  const s = getSettings();
  const channel = w.notify_channel_id ?? s.notifyChannelId;
  e.addFields({
    name: 'Notifications',
    value: w.notify_enabled ? `On, sent to ${channel ? `<#${channel}>` : 'your DMs'}` : 'Off for this wallet',
  });
  const recent = transfers.list({ walletId: w.id }, 5, 0);
  if (recent.length) {
    const tracked = trackedIndex();
    e.addFields({ name: 'Recent Activity', value: fieldValue(recent.map((t) => transferLine(t, tracked, false)).join('\n\n')) });
  }
  return footer(e, `Wallet ID ${w.id}`).setTimestamp(new Date());
}

function viewButtons(w: WalletRow): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wallet:refresh:${w.id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`txl:0:${w.id}:::all`).setLabel('Transactions').setStyle(ButtonStyle.Primary),
  );
}

async function add(i: ChatInputCommandInteraction): Promise<void> {
  const rawAddress = i.options.getString('address', true).trim();
  const label = i.options.getString('label', true).trim();
  const choice = i.options.getString('network') ?? 'auto';
  const hint: NetworkHint = choice === 'auto' || choice === 'evm' ? choice : isNetworkId(choice) ? [choice] : 'auto';

  const planned = planWallet(rawAddress, hint);
  if (!planned.ok && planned.kind === 'secret') {
    // Always private, even with public replies: never echo anything about a secret.
    await i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        footer(
          base(COLORS.danger)
            .setTitle('Not Saved: This Looks Like a Secret')
            .setDescription(
              `${planned.message}\n\nThis bot only ever needs a **public address**. Nothing was stored or logged.\n\nIf this was a real private key or recovery phrase, treat it as exposed: create a new wallet and move your funds.`,
            ),
        ),
      ],
    });
    return;
  }
  if (!planned.ok) {
    if (planned.kind === 'ambiguous') {
      return fail(
        i,
        `${planned.message}\n${(planned.options ?? []).map((o) => `- ${o}`).join('\n')}\n\nRun the command again and choose the **network** option.`,
        'Choose a Network',
      );
    }
    return fail(i, planned.message, planned.kind === 'mismatch' ? 'Network Mismatch' : 'Invalid Address');
  }
  if (!LABEL_RE.test(label)) return fail(i, LABEL_RULES, 'Invalid Label');
  if (wallets.byLabel(label)) return fail(i, `A wallet named **${safe(label)}** already exists. Pick another label.`, 'Duplicate Label');
  if (isBeingAdded(planned.plan.candidate.address)) {
    return fail(i, 'This address is being added right now. Wait a moment and check `/wallet list`.', 'Already Being Added');
  }

  await defer(i);
  const res = await createTrackedWallet(label, planned.plan);
  if (!res.ok) {
    const details = res.failed?.[0] ? `\n\nDetails: ${safe(res.failed[0].error, 300)}` : '';
    const title =
      res.reason === 'duplicate' ? 'Already Tracked' : res.reason === 'unreachable' ? 'Network Unavailable' : 'Could Not Add Wallet';
    const extra = res.reason === 'unreachable' ? ' Nothing was saved; please try again in a minute.' : '';
    return fail(i, `${safe(res.message, 300)}${extra}${details}`, title);
  }
  const e = await walletAddedEmbed(res.wallet, planned.plan.candidate.description, res.added, res.failed);
  await respond(i, { embeds: [e], components: [viewButtons(res.wallet)] });
}

async function walletAddedEmbed(w: WalletRow, description: string, added: NetworkId[], failed: NetworkFailure[]): Promise<EmbedBuilder> {
  const { items, total } = await walletBalances(w.id);
  const slow = added.filter((n) => n === 'bsc' || n === 'base');
  const e = successEmbed('Wallet Added', `**${safe(w.label)}** is now tracked. You will be notified about new transactions from now on.`);
  e.addFields(
    { name: 'Address', value: addressLink(added[0]!, w.address) },
    { name: 'Type', value: description, inline: true },
    { name: 'Networks', value: added.map((n) => NETWORKS[n].name).join(', '), inline: true },
    { name: 'Current Value', value: usd(total), inline: true },
  );
  const held = items.filter((b) => b.amount !== 0n);
  if (held.length) {
    e.addFields({
      name: 'Balances',
      value: fieldValue(
        held.map((b) => `${NETWORKS[b.network].name}: ${coin(formatUnits(b.amount, b.decimals), b.label)} (${usd(b.value)})`).join('\n'),
      ),
    });
  }
  const slowNote = slow.length
    ? ` (${slow.map((n) => NETWORKS[n].name).join(' and ')} use a slower block-by-block scan and can take a while)`
    : '';
  e.addFields({
    name: 'Transaction History',
    value: `Importing the full history in the background${slowNote}. You will get a message when it is done. Check progress with \`/wallet view\`.`,
  });
  if (failed.length) {
    e.addFields({
      name: 'Not Started',
      value: fieldValue(
        failed.map((f) => `${NETWORKS[f.network].name}: ${safe(f.error, 150)}`).join('\n') + '\nUse `/wallet networks` to retry later.',
      ),
    });
  }
  return e;
}

async function list(i: ChatInputCommandInteraction): Promise<void> {
  await defer(i);
  const all = wallets.list();
  const e = base(COLORS.brand).setTitle('Tracked Wallets');
  if (!all.length) {
    e.setDescription('No wallets yet. Add one with `/wallet add address:<address> label:<name>`.');
    return respond(i, { embeds: [footer(e)] });
  }
  let grand = 0;
  const rows: Array<{ w: WalletRow; total: number; status: string; nets: string }> = [];
  const problems: string[] = [];
  for (const w of all) {
    const { total } = await walletBalances(w.id);
    grand += total;
    const wns = walletNetworks.forWallet(w.id);
    rows.push({ w, total, status: shortStatus(wns), nets: wns.map((wn) => NET_SHORT[wn.network]).join(', ') });
    for (const wn of wns) {
      if (wn.consecutive_errors >= 3 || wn.backfill_status === 'error')
        problems.push(`**${safe(w.label, 40)}** on ${NET_SHORT[wn.network]}: ${syncStatus(wn)}`);
    }
  }
  rows.sort((a, b) => b.total - a.total);
  e.setDescription(['Total Value', `# ${usd(grand)}`, `${plural(all.length, 'wallet')} tracked`].join('\n'));
  // Tables hold ~25 rows within Discord's field size; more wallets are summarized.
  const shown = rows.slice(0, 25);
  e.addFields({
    name: 'Wallets',
    value: fieldValue(
      table(
        [
          { header: 'WALLET', max: 14 },
          { header: 'VALUE', align: 'right' },
          { header: 'STATUS', max: 12 },
        ],
        shown.map((r) => [r.w.label, usdShort(r.total), r.w.notify_enabled ? r.status : `${r.status}, muted`]),
      ) + (rows.length > shown.length ? `\n${plural(rows.length - shown.length, 'more wallet')} not shown.` : ''),
    ),
  });
  e.addFields({
    name: 'Networks',
    value: fieldValue(shown.map((r) => `**${safe(r.w.label, 40)}**: ${r.nets}`).join('\n')),
  });
  if (problems.length) e.addFields({ name: 'Needs Attention', value: fieldValue(problems.join('\n')) });
  await respond(i, { embeds: [footer(e, '/wallet view <name> for balances, address and activity')] });
}

async function view(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name. Use `/wallet list` to see your wallets.', 'Wallet Not Found');
  await defer(i);
  await respond(i, { embeds: [await walletViewEmbed(w)], components: [viewButtons(w)] });
}

async function remove(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  const count = walletNetworks.forWallet(w.id).reduce((s, wn) => s + transfers.countForWalletNetwork(wn.id), 0);
  const e = base(COLORS.warning)
    .setTitle('Remove Wallet?')
    .setDescription(
      `This stops tracking **${safe(w.label)}** and deletes its ${plural(count, 'stored transaction')}, categories and notes from the bot. Nothing happens to the wallet itself.\n\nThis cannot be undone.`,
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wallet:rm:${w.id}`).setLabel('Remove Wallet').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wallet:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await respond(i, { embeds: [footer(e)], components: [row] });
}

async function sync(i: ChatInputCommandInteraction): Promise<void> {
  await defer(i);
  const report = await syncWalletFile();
  await respond(i, { embeds: [walletFileEmbed(report)] });
}

async function rename(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  const label = i.options.getString('new_label', true).trim();
  if (!LABEL_RE.test(label)) return fail(i, LABEL_RULES, 'Invalid Label');
  const existing = wallets.byLabel(label);
  if (existing && existing.id !== w.id) return fail(i, `A wallet named **${safe(label)}** already exists.`, 'Duplicate Label');
  wallets.rename(w.id, label);
  const fileNote = walletFileHasAddress(w.address)
    ? `\n\nThis wallet is also listed in **${basename(walletFilePath())}**. The new name is kept; it only changes again if you edit the name on that line.`
    : '';
  await respond(i, { embeds: [successEmbed('Wallet Renamed', `**${safe(w.label)}** is now **${safe(label)}**.${fileNote}`)] });
}

async function notifications(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  const enabled = i.options.getBoolean('enabled', true);
  const channel = i.options.getChannel('channel');
  const useDefault = i.options.getBoolean('use_default_destination') ?? false;
  const channelId = useDefault ? null : channel ? channel.id : undefined;
  wallets.setNotify(w.id, enabled, channelId);
  const s = getSettings();
  const finalChannel = channelId === undefined ? (w.notify_channel_id ?? s.notifyChannelId) : (channelId ?? s.notifyChannelId);
  await respond(i, {
    embeds: [
      successEmbed(
        'Wallet Notifications Updated',
        enabled
          ? `Notifications for **${safe(w.label)}** are **on** and go to ${finalChannel ? `<#${finalChannel}>` : 'your DMs'}.`
          : `Notifications for **${safe(w.label)}** are **off**. The wallet is still tracked for your portfolio.`,
      ),
    ],
  });
}

async function networks(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  if (w.family !== 'evm')
    return fail(i, `**${safe(w.label)}** is a ${familyLabel(w)} wallet and only exists on one network.`, 'Not an EVM Wallet');
  const current = new Set(walletNetworks.forWallet(w.id).map((wn) => wn.network));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`wallet:nets:${w.id}`)
    .setPlaceholder('Select the networks to track')
    .setMinValues(1)
    .setMaxValues(EVM_NETWORKS.length)
    .addOptions(EVM_NETWORKS.map((n) => ({ label: NETWORKS[n].name, value: n, default: current.has(n) })));
  await respond(i, {
    embeds: [
      footer(
        base(COLORS.brand)
          .setTitle(`Networks for ${safe(w.label)}`)
          .setDescription('Choose which EVM networks this address is tracked on. Removing a network deletes its stored transactions.'),
      ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
}

async function refresh(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  await defer(i);
  await Promise.allSettled(walletNetworks.forWallet(w.id).map((wn) => tracker.pollNow(wn.id)));
  await respond(i, { embeds: [await walletViewEmbed(w)], components: [viewButtons(w)] });
}

async function reimport(i: ChatInputCommandInteraction): Promise<void> {
  const w = findWallet(i.options.getString('wallet', true));
  if (!w) return fail(i, 'No wallet with that name.', 'Wallet Not Found');
  const wns = walletNetworks.forWallet(w.id);
  // A pending automatic retry does not block a manual re-import (it starts it right away).
  const busy = wns.filter((wn) => backfills.isActive(wn.id));
  if (busy.length)
    return fail(i, 'A history import is already running for this wallet. Check `/wallet view` for progress.', 'Import Running');
  for (const wn of wns) backfills.enqueue(wn.id);
  await respond(i, {
    embeds: [
      successEmbed(
        'History Import Restarted',
        `Re-importing history for **${safe(w.label)}** on ${wns.map((wn) => NETWORKS[wn.network].name).join(', ')}. Existing transactions, categories and notes are kept.`,
      ),
    ],
  });
}

export const walletCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Add, view and manage tracked wallet addresses')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Track a new wallet by its public address')
        .addStringOption((o) =>
          o.setName('address').setDescription('Public address (never a private key or seed phrase)').setRequired(true).setMaxLength(120),
        )
        .addStringOption((o) =>
          o.setName('label').setDescription('A name for this wallet, e.g. "Main LTC"').setRequired(true).setMaxLength(40),
        )
        .addStringOption((o) =>
          o
            .setName('network')
            .setDescription('Usually auto-detected')
            .addChoices(...NETWORK_OPTION),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List all tracked wallets with value and sync status'))
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription('Balances, sync status and recent activity of one wallet')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename a wallet')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('new_label').setDescription('New name').setRequired(true).setMaxLength(40)),
    )
    .addSubcommand((s) =>
      s
        .setName('notifications')
        .setDescription('Turn notifications on or off for one wallet, or send them to a specific channel')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true))
        .addBooleanOption((o) => o.setName('enabled').setDescription('Send notifications for this wallet').setRequired(true))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription("Send this wallet's notifications to this channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addBooleanOption((o) => o.setName('use_default_destination').setDescription('Go back to the default destination from /settings')),
    )
    .addSubcommand((s) =>
      s
        .setName('networks')
        .setDescription('Choose which EVM networks an 0x address is tracked on')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('refresh')
        .setDescription('Sync a wallet right now')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reimport')
        .setDescription('Re-run the full history import for a wallet')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('sync').setDescription('Re-read wallets.txt now and start tracking any new addresses in it'))
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Stop tracking a wallet and delete its stored data')
        .addStringOption((o) => o.setName('wallet').setDescription('Wallet').setRequired(true).setAutocomplete(true)),
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const handlers: Record<string, (i: ChatInputCommandInteraction) => Promise<void>> = {
      add,
      list,
      view,
      remove,
      rename,
      notifications,
      networks,
      refresh,
      reimport,
      sync,
    };
    await handlers[sub]?.(i);
  },

  autocomplete: autocompleteWallet,

  components: {
    async wallet(i, args) {
      const [action, idText] = args;
      if (action === 'cancel' && i.isButton()) {
        await i.update({
          embeds: [footer(base(COLORS.muted).setTitle('Cancelled').setDescription('Nothing was changed.'))],
          components: [],
        });
        return;
      }
      const w = wallets.get(Number(idText));
      if (!w) {
        if (i.isButton() || i.isStringSelectMenu())
          await i.update({
            embeds: [footer(base(COLORS.muted).setTitle('Wallet not found').setDescription('It may have been removed already.'))],
            components: [],
          });
        return;
      }
      if (action === 'rm' && i.isButton()) {
        for (const wn of walletNetworks.forWallet(w.id)) {
          tracker.unschedule(wn.id);
          backfills.cancel(wn.id);
        }
        wallets.remove(w.id);
        log.info(`wallet removed: ${w.label}`);
        const fileNote = walletFileHasAddress(w.address)
          ? `\n\nThis address is still listed in **${basename(walletFilePath())}**. Delete that line too, or it will be added again the next time the file is read.`
          : '';
        await i.update({
          embeds: [successEmbed('Wallet Removed', `**${safe(w.label)}** is no longer tracked and its stored data was deleted.${fileNote}`)],
          components: [],
        });
        return;
      }
      if (action === 'refresh' && i.isButton()) {
        await i.deferUpdate();
        await Promise.allSettled(walletNetworks.forWallet(w.id).map((wn) => tracker.pollNow(wn.id)));
        await i.editReply({ embeds: [await walletViewEmbed(w)], components: [viewButtons(w)] });
        return;
      }
      if (action === 'nets' && i.isStringSelectMenu()) {
        await i.deferUpdate();
        const wanted = new Set(i.values.filter((v): v is NetworkId => (EVM_NETWORKS as readonly string[]).includes(v)));
        const current = walletNetworks.forWallet(w.id);
        const lines: string[] = [];
        for (const wn of current) {
          if (!wanted.has(wn.network)) {
            tracker.unschedule(wn.id);
            backfills.cancel(wn.id);
            walletNetworks.remove(wn.id);
            lines.push(`Removed ${NETWORKS[wn.network].name}`);
          }
        }
        for (const n of wanted) {
          if (current.some((wn) => wn.network === n)) continue;
          try {
            await getAdapter(n).getTip();
            await tracker.addWalletNetwork(w.id, n, w.address);
            lines.push(`Added ${NETWORKS[n].name} (history import started)`);
          } catch (err) {
            lines.push(`Could not add ${NETWORKS[n].name}: ${safe(redact(err instanceof Error ? err.message : String(err)), 120)}`);
          }
        }
        const fileNote = walletFileHasAddress(w.address)
          ? `\n\n${basename(walletFilePath())} will not add removed networks back unless you change this wallet's line there.`
          : '';
        await i.editReply({
          embeds: [successEmbed(`Networks for ${safe(w.label)}`, (lines.length ? lines.join('\n') : 'No changes.') + fileNote)],
          components: [],
        });
      }
    },
  },
};
