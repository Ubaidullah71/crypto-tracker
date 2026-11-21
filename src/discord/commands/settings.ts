import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
} from 'discord.js';
import { getConfig } from '../../config.ts';
import { NETWORK_IDS, NETWORKS, type NetworkId } from '../../core/networks.ts';
import { getSettings, requiredConfirmations, updateSettings, type AppSettings } from '../../settings.ts';
import { usd } from '../../util/format.ts';
import { parseHhMm } from '../../util/time.ts';
import { defer, fail, respond, successEmbed, type Command } from '../common.ts';
import { base, COLORS, fieldValue, footer } from '../theme.ts';
import { outbox } from '../outbox.ts';

const yesNo = (b: boolean) => (b ? 'On' : 'Off');
const dest = (id: string | null, fallback = 'Your DMs') => (id ? `<#${id}>` : fallback);

function settingsEmbed(s: AppSettings) {
  const cfg = getConfig();
  const e = base(COLORS.brand).setTitle('Settings');
  e.addFields(
    {
      name: 'Notifications',
      value: [
        `Destination: ${dest(s.notifyChannelId)}`,
        `Incoming: ${yesNo(s.notifyIncoming)}, Outgoing: ${yesNo(s.notifyOutgoing)}`,
        `"Seen" alerts before confirmation: ${yesNo(s.notifySeen)}`,
        `Minimum value: ${usd(s.minNotifyUsd)}`,
        `Mention me in channel posts: ${yesNo(s.mentionOwner)}`,
        `History import messages: ${yesNo(s.importNotices)}`,
      ].join('\n'),
    },
    {
      name: 'Daily Summary',
      value: `${yesNo(s.summaryEnabled)} at ${s.summaryTime} (${cfg.timezone})\nDestination: ${dest(s.summaryChannelId, 'Same as notifications')}`,
      inline: true,
    },
    { name: 'Price Alerts', value: `Destination: ${dest(s.alertsChannelId, 'Same as notifications')}`, inline: true },
    { name: 'Privacy', value: `Private command replies in servers: ${yesNo(s.privateReplies)}`, inline: true },
    {
      name: 'Confirmations Required',
      value: fieldValue(
        NETWORK_IDS.filter((n) => NETWORKS[n].family === 'utxo' || NETWORKS[n].family === 'evm')
          .map((n) => `${NETWORKS[n].name}: ${requiredConfirmations(n, s)}${s.confirmations[n] ? ' (custom)' : ''}`)
          .join('\n') + '\nSolana and XRP: final status from the network',
      ),
    },
  );
  return footer(e, 'Time zone is set in .env (TIMEZONE)');
}

function checkChannel(i: ChatInputCommandInteraction, ch: GuildBasedChannel | null): string | null {
  if (!ch) return null;
  const me = i.guild?.members.me;
  if (!me) return 'I could not check my permissions in that server.';
  const perms = ch.permissionsFor(me);
  const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (!perms || !need.every((p) => perms.has(p))) {
    return `I need View Channel, Send Messages and Embed Links permissions in <#${ch.id}>.`;
  }
  return null;
}

async function notifications(i: ChatInputCommandInteraction): Promise<void> {
  const channel = i.options.getChannel('channel') as GuildBasedChannel | null;
  const problem = checkChannel(i, channel);
  if (problem) return fail(i, problem, 'Missing Permissions');
  const patch: Partial<AppSettings> = {};
  if (channel) patch.notifyChannelId = channel.id;
  if (i.options.getBoolean('dm')) patch.notifyChannelId = null;
  const map: Array<[string, keyof AppSettings]> = [
    ['incoming', 'notifyIncoming'],
    ['outgoing', 'notifyOutgoing'],
    ['seen_alerts', 'notifySeen'],
    ['mention', 'mentionOwner'],
    ['import_messages', 'importNotices'],
  ];
  for (const [opt, key] of map) {
    const v = i.options.getBoolean(opt);
    if (v !== null) (patch as Record<string, unknown>)[key] = v;
  }
  const min = i.options.getNumber('min_usd');
  if (min !== null) patch.minNotifyUsd = min;
  const s = updateSettings(patch);
  await respond(i, {
    embeds: [successEmbed('Notification Settings Saved', `Notifications go to ${dest(s.notifyChannelId)}.`), settingsEmbed(s)],
  });
}

async function summary(i: ChatInputCommandInteraction): Promise<void> {
  const patch: Partial<AppSettings> = {};
  const enabled = i.options.getBoolean('enabled');
  if (enabled !== null) patch.summaryEnabled = enabled;
  const time = i.options.getString('time');
  if (time !== null) {
    const t = parseHhMm(time);
    if (!t) return fail(i, 'Use 24-hour HH:MM format, for example 09:00 or 21:30.', 'Invalid Time');
    patch.summaryTime = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  }
  const channel = i.options.getChannel('channel') as GuildBasedChannel | null;
  const problem = checkChannel(i, channel);
  if (problem) return fail(i, problem, 'Missing Permissions');
  if (channel) patch.summaryChannelId = channel.id;
  if (i.options.getBoolean('same_as_notifications')) patch.summaryChannelId = null;
  const s = updateSettings(patch);
  if (i.options.getBoolean('send_now')) {
    await defer(i);
    const ok = await outbox.dailySummary({ channelId: s.summaryChannelId ?? s.notifyChannelId, mention: false });
    await respond(i, {
      embeds: [
        successEmbed(
          'Daily Summary',
          ok ? 'Sent a summary now.' : 'Could not send the summary. Check the destination channel permissions.',
        ),
        settingsEmbed(s),
      ],
    });
    return;
  }
  await respond(i, {
    embeds: [
      successEmbed(
        'Summary Settings Saved',
        s.summaryEnabled ? `Daily summary at ${s.summaryTime} (${getConfig().timezone}).` : 'Daily summary is off.',
      ),
      settingsEmbed(s),
    ],
  });
}

async function alertsDest(i: ChatInputCommandInteraction): Promise<void> {
  const channel = i.options.getChannel('channel') as GuildBasedChannel | null;
  const problem = checkChannel(i, channel);
  if (problem) return fail(i, problem, 'Missing Permissions');
  const patch: Partial<AppSettings> = {};
  if (channel) patch.alertsChannelId = channel.id;
  if (i.options.getBoolean('same_as_notifications')) patch.alertsChannelId = null;
  const s = updateSettings(patch);
  await respond(i, {
    embeds: [successEmbed('Alert Settings Saved', `Price alerts go to ${dest(s.alertsChannelId ?? s.notifyChannelId)}.`)],
  });
}

async function confirmations(i: ChatInputCommandInteraction): Promise<void> {
  const network = i.options.getString('network', true) as NetworkId;
  const count = i.options.getInteger('count');
  const s = getSettings();
  const next = { ...s.confirmations };
  if (count === null) delete next[network];
  else next[network] = count;
  const saved = updateSettings({ confirmations: next });
  await respond(i, {
    embeds: [
      successEmbed(
        'Confirmations Saved',
        `${NETWORKS[network].name} transactions are reported as confirmed after **${requiredConfirmations(network, saved)}** confirmation(s).`,
      ),
    ],
  });
}

async function privacy(i: ChatInputCommandInteraction): Promise<void> {
  const v = i.options.getBoolean('private_replies', true);
  const s = updateSettings({ privateReplies: v });
  await respond(i, {
    embeds: [
      successEmbed(
        'Privacy Saved',
        v
          ? 'Command replies in servers are now only visible to you.'
          : 'Command replies in servers are now visible to everyone in the channel.',
      ),
      settingsEmbed(s),
    ],
  });
}

const textChannel = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

export const settingsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Notification, summary, alert and privacy settings')
    .addSubcommand((s) => s.setName('view').setDescription('Show current settings'))
    .addSubcommand((s) =>
      s
        .setName('notifications')
        .setDescription('Where and when transaction notifications are sent')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Send notifications to this channel')
            .addChannelTypes(...textChannel),
        )
        .addBooleanOption((o) => o.setName('dm').setDescription('Send notifications to your DMs instead of a channel'))
        .addBooleanOption((o) => o.setName('incoming').setDescription('Notify about incoming transactions'))
        .addBooleanOption((o) => o.setName('outgoing').setDescription('Notify about outgoing transactions'))
        .addBooleanOption((o) => o.setName('seen_alerts').setDescription('Send a "Seen" alert before the "Confirmed" one'))
        .addNumberOption((o) =>
          o
            .setName('min_usd')
            .setDescription('Ignore transactions worth less than this many USD (spam / dust)')
            .setMinValue(0)
            .setMaxValue(1_000_000),
        )
        .addBooleanOption((o) => o.setName('mention').setDescription('Mention you in channel notifications so your phone pings'))
        .addBooleanOption((o) => o.setName('import_messages').setDescription('Post a message when a history import finishes')),
    )
    .addSubcommand((s) =>
      s
        .setName('summary')
        .setDescription('Daily portfolio summary')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Send a daily summary'))
        .addStringOption((o) => o.setName('time').setDescription('Time of day, 24h HH:MM (in your TIMEZONE)').setMaxLength(5))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Send summaries to this channel')
            .addChannelTypes(...textChannel),
        )
        .addBooleanOption((o) => o.setName('same_as_notifications').setDescription('Use the notification destination'))
        .addBooleanOption((o) => o.setName('send_now').setDescription('Send a summary right now')),
    )
    .addSubcommand((s) =>
      s
        .setName('alerts')
        .setDescription('Where price alerts are sent')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Send price alerts to this channel')
            .addChannelTypes(...textChannel),
        )
        .addBooleanOption((o) => o.setName('same_as_notifications').setDescription('Use the notification destination')),
    )
    .addSubcommand((s) =>
      s
        .setName('confirmations')
        .setDescription('How many confirmations before a transaction counts as confirmed')
        .addStringOption((o) =>
          o
            .setName('network')
            .setDescription('Network')
            .setRequired(true)
            .addChoices(
              ...NETWORK_IDS.filter((n) => NETWORKS[n].family === 'utxo' || NETWORKS[n].family === 'evm').map((n) => ({
                name: NETWORKS[n].name,
                value: n,
              })),
            ),
        )
        .addIntegerOption((o) =>
          o.setName('count').setDescription('Confirmations (leave empty to reset to default)').setMinValue(1).setMaxValue(200),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('privacy')
        .setDescription('Make command replies in servers visible only to you')
        .addBooleanOption((o) => o.setName('private_replies').setDescription('Only you can see replies').setRequired(true)),
    ),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'notifications') return notifications(i);
    if (sub === 'summary') return summary(i);
    if (sub === 'alerts') return alertsDest(i);
    if (sub === 'confirmations') return confirmations(i);
    if (sub === 'privacy') return privacy(i);
    await respond(i, { embeds: [settingsEmbed(getSettings())] });
  },
};
