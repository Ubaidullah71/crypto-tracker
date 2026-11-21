import { basename } from 'node:path';
import { ActionRowBuilder, SlashCommandBuilder, StringSelectMenuBuilder, type EmbedBuilder } from 'discord.js';
import { getConfig } from '../../config.ts';
import { getSettings } from '../../settings.ts';
import { respond, type Command } from '../common.ts';
import { base, COLORS, footer } from '../theme.ts';

interface Topic {
  id: string;
  label: string;
  description: string;
  build: () => EmbedBuilder;
}

const page = (title: string) => base(COLORS.brand).setTitle(title);

const TOPICS: Topic[] = [
  {
    id: 'start',
    label: 'Getting Started',
    description: 'Set up notifications and add your wallets',
    build: () => {
      const file = basename(getConfig().walletsFile);
      const dest = getSettings().notifyChannelId;
      return page('Getting Started')
        .setDescription(
          'This bot watches your wallet addresses, tells you when money arrives or leaves, and keeps your portfolio with profit and loss. It only ever uses **public addresses**: it never needs a private key or recovery phrase and cannot move funds.',
        )
        .addFields(
          {
            name: 'Step 1: Choose where notifications go',
            value: `\`/settings notifications channel:#your-channel\`\nor \`/settings notifications dm:true\` for direct messages.\nRight now they go to: ${dest ? `<#${dest}>` : 'your DMs'}.`,
          },
          {
            name: 'Step 2: Add your wallets',
            value: `Open **${file}** in the bot folder, write one \`Name = address\` per line and save. The bot picks it up within seconds and posts a "Wallet File Synced" message.\nOne at a time also works: \`/wallet add\`.`,
          },
          {
            name: 'Step 3: Wait for the history import',
            value:
              'Past transactions are imported in the background so profit and loss is correct from day one. You get a message when each import finishes. Old transactions never trigger payment notifications.',
          },
          {
            name: 'Step 4: Look around',
            value: '`/portfolio` for your totals, `/wallet list` for every wallet, `/transactions` for history.',
          },
        );
    },
  },
  {
    id: 'wallets',
    label: 'Adding Wallets',
    description: 'wallets.txt, /wallet add, Ledger and Trezor accounts',
    build: () =>
      page('Adding Wallets').addFields(
        {
          name: 'wallets.txt (recommended)',
          value: [
            'One line per address: `Name = address`. Save the file and it is picked up automatically.',
            'Several addresses for the same coin are simply several lines.',
            'Lines can share a name, e.g. the wallet app: several lines called `Exodus` become Exodus BTC, Exodus LTC, Exodus EVM and so on.',
            'Removing a line does not delete anything; use `/wallet remove` for that.',
            '`/wallet sync` re-reads the file right away and shows what changed.',
          ].join('\n'),
        },
        {
          name: 'Which networks',
          value: [
            'The network is detected from the address.',
            'A **0x address** covers Ethereum, BNB Chain, Polygon and Base, including USDT and USDC on each, so list it once.',
            'To watch only some networks: `Name = 0x... @ bsc, base`.',
            'A **Solana** address covers SOL, USDT and USDC.',
          ].join('\n'),
        },
        {
          name: 'Ledger, Trezor and Electrum accounts',
          value: [
            'Use the account key (xpub, ypub, zpub or Ltub) instead of an address to track every address of a Bitcoin or Litecoin account.',
            'Ledger Live: Accounts, open the account, wrench icon, Advanced, copy xpub.',
            'A Litecoin key that starts with "xpub" needs `@ litecoin` at the end.',
          ].join('\n'),
        },
        {
          name: 'Managing wallets',
          value:
            '`/wallet list` all wallets with value and status\n`/wallet view` balances, address, sync status and recent activity\n`/wallet rename`, `/wallet notifications` (mute or move one wallet), `/wallet networks` (EVM networks)\n`/wallet refresh` sync now, `/wallet reimport` import history again, `/wallet remove`',
        },
      ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Seen and Confirmed alerts, filters and pings',
    build: () => {
      const s = getSettings();
      return page('Notifications').addFields(
        {
          name: 'What you receive',
          value: [
            '**Transaction Seen**: money is on its way but not confirmed yet (amount, fee, fee rate, ETA).',
            '**Transaction Confirmed**: it is final (time taken, block, your new balance).',
            'Outgoing transactions, dropped or replaced transactions, and failed transactions are reported too.',
            'If the bot was offline, missed transactions arrive as one "Activity Catch-Up" message.',
          ].join('\n'),
        },
        {
          name: 'Settings',
          value: [
            '`/settings notifications` channel or DMs, incoming, outgoing, seen alerts, minimum value, mention',
            `Currently: minimum ${s.minNotifyUsd > 0 ? `$${s.minNotifyUsd}` : 'none'}, "Seen" alerts ${s.notifySeen ? 'on' : 'off'}, mention ${s.mentionOwner ? 'on' : 'off'}.`,
            '`/wallet notifications` mutes one wallet or sends it to its own channel.',
            '`/settings confirmations` changes how many confirmations count as "Confirmed".',
          ].join('\n'),
        },
        {
          name: 'Safety warnings',
          value:
            'Address poisoning: scammers send dust from addresses that start and end like yours or like someone you paid. That dust is hidden from lists and alerts automatically, and a real payment from such an address comes with a warning. Never copy an address from your transaction history.',
        },
      );
    },
  },
  {
    id: 'portfolio',
    label: 'Portfolio and Profit/Loss',
    description: 'How totals, average price and profit are calculated',
    build: () =>
      page('Portfolio and Profit/Loss').addFields(
        {
          name: 'Commands',
          value:
            '`/portfolio` totals with Overview, Wallets and Networks views (tap the highlighted button to refresh)\n`/coin` one coin in depth\n`/price` market prices',
        },
        {
          name: 'How profit and loss works',
          value: [
            'Average cost method (like CoinGecko), per coin across all wallets.',
            '**Incoming** counts as bought at the market price at that moment.',
            '**Outgoing** counts as sold at the market price, unless it went to another wallet you track (detected automatically) or you mark it as a transfer to your own wallet.',
            '**Network fees** you pay are included.',
            '**Invested** is what your current holdings cost; **Realized** is profit already taken by selling or spending.',
          ].join('\n'),
        },
        {
          name: 'Make it exact',
          value:
            'If you bought at a different price than the market price at the time, set it with `/tx edit price:`. Coins marked "pricing" are still getting historical prices and show profit/loss once done.',
        },
      ),
  },
  {
    id: 'transactions',
    label: 'Transactions and Categories',
    description: 'Browse history, mark payments, purchases and transfers',
    build: () =>
      page('Transactions and Categories').addFields(
        {
          name: 'Browse',
          value: '`/transactions` with filters for wallet, coin, direction and period. Each entry links to the block explorer.',
        },
        {
          name: 'Change how a transaction counts',
          value: [
            '`/tx view <hash>` shows everything and lets you pick a category, set a price or add a note with buttons.',
            'Categories for incoming: Payment received, Purchase, Transfer from my own wallet, Between my tracked wallets, Ignore.',
            'Categories for outgoing: Sale, Spend, Transfer to my own wallet, Between my tracked wallets, Ignore.',
            '`/tx edit` does the same in one command.',
          ].join('\n'),
        },
        { name: 'Tip', value: 'Mark spam and dust as "Ignore" so it never affects your totals.' },
      ),
  },
  {
    id: 'reports',
    label: 'Reports, Export and Alerts',
    description: 'Income reports, CSV files, daily summary, price alerts',
    build: () =>
      page('Reports, Export and Alerts').addFields(
        {
          name: 'Reports',
          value:
            '`/report period:` money in and out, payments received by type and coin, fees and realized profit. Add `wallet:` for one wallet.',
        },
        {
          name: 'Export',
          value:
            '`/export transactions` every transaction as a CSV file for Excel or Google Sheets.\n`/export portfolio` current holdings with average price and profit/loss.',
        },
        {
          name: 'Daily summary',
          value:
            '`/settings summary time:09:00` a daily post with total value, changes, holdings and what you received. `send_now:true` sends one immediately.',
        },
        {
          name: 'Price alerts',
          value: '`/alert add coin:BTC when:above price:70000` (add `repeat:true` to fire every time)\n`/alert list`, `/alert remove id:`',
        },
      ),
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Every option and what it does',
    build: () =>
      page('Settings').addFields(
        { name: '/settings view', value: 'Shows all current settings.' },
        {
          name: '/settings notifications',
          value: 'Destination channel or DMs, incoming, outgoing, "Seen" alerts, minimum USD value, mention you, history import messages.',
        },
        { name: '/settings summary', value: 'Daily summary on or off, time of day (your TIMEZONE from .env), channel.' },
        { name: '/settings alerts', value: 'Channel for price alerts.' },
        {
          name: '/settings confirmations',
          value: 'Confirmations needed per network before "Confirmed" (Bitcoin and Litecoin default 1, EVM networks 3 to 5).',
        },
        { name: '/settings privacy', value: 'Make command replies in servers visible only to you.' },
        {
          name: 'In .env (restart needed)',
          value: 'Discord token and owners, Etherscan keys (several allowed), proxies, time zone, wallets file location.',
        },
      ),
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    description: 'Imports, sync problems and missing messages',
    build: () =>
      page('Troubleshooting').addFields(
        { name: 'Check health first', value: "`/status` shows each wallet's sync state, history imports, data providers and connections." },
        {
          name: 'History import is slow or retrying',
          value:
            'BNB Chain and Base history is rebuilt block by block from free public nodes, which limit how fast one IP can ask. Failed imports retry automatically after 2, 10, 30 and 60 minutes. Proxies in .env (PROXY_URLS) make big imports much faster.',
        },
        {
          name: '"Sync issue" on a wallet',
          value: 'A free data provider is down or rate limiting. The bot switches providers automatically; it usually clears by itself.',
        },
        {
          name: 'No messages arrive',
          value:
            'Check `/settings view` for the destination. For DMs, allow direct messages from server members. In a channel, the bot needs View Channel, Send Messages and Embed Links.',
        },
        {
          name: 'A number looks wrong',
          value:
            'Open the coin with `/coin` and the transaction with `/tx view`. Set a category or your real price if the default does not fit.',
        },
      ),
  },
  {
    id: 'security',
    label: 'Privacy and Security',
    description: 'What the bot can and cannot do',
    build: () =>
      page('Privacy and Security').addFields(
        {
          name: 'Read-only',
          value:
            'The bot only knows public addresses. It never asks for, stores or needs a private key or recovery phrase, and it cannot send funds. If you paste a secret by mistake, it is refused and not saved.',
        },
        {
          name: 'Who can use it',
          value:
            'Only the Discord users listed in OWNER_IDS. Commands are hidden from non-admins in servers; anyone else gets "This is a private bot."',
        },
        {
          name: 'Your data',
          value:
            'Everything is stored locally in data/portfolio.db and wallets.txt on your machine. Blockchain data comes from free public APIs; no account with a tracking service is used. Keep .env, wallets.txt and the database private.',
        },
      ),
  },
];

function menu(selected: string): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help:topic')
      .setPlaceholder('Choose a help topic')
      .addOptions(
        TOPICS.map((t) => ({ label: t.label, value: t.id, description: t.description.slice(0, 100), default: t.id === selected })),
      ),
  );
}

function render(id: string): { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<StringSelectMenuBuilder>> } {
  const t = TOPICS.find((x) => x.id === id) ?? TOPICS[0]!;
  const n = TOPICS.indexOf(t) + 1;
  return { embeds: [footer(t.build(), `Help ${n} of ${TOPICS.length}  |  pick another topic below`)], components: [menu(t.id)] };
}

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to use this bot, topic by topic')
    .addStringOption((o) =>
      o
        .setName('topic')
        .setDescription('Jump to a topic')
        .addChoices(...TOPICS.map((t) => ({ name: t.label, value: t.id }))),
    ),
  async execute(i) {
    await respond(i, render(i.options.getString('topic') ?? 'start'));
  },
  components: {
    async help(i, args) {
      if (args[0] !== 'topic' || !i.isStringSelectMenu()) return;
      await i.update(render(i.values[0] ?? 'start'));
    },
  },
};
