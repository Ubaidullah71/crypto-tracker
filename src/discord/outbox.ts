import type { Client, EmbedBuilder, MessageCreateOptions } from 'discord.js';
import { ASSETS } from '../core/assets.ts';
import { getConfig } from '../config.ts';
import { alerts as alertRepo, snapshots, wallets, type AlertRow, type TransferWithWallet, type WalletNetworkJoined } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import { buildPortfolio } from '../portfolio/portfolio.ts';
import { flowReport } from '../portfolio/reports.ts';
import type { Quote } from '../prices/prices.ts';
import type { Destination, ImportNotice, Outbox, TransferNotice } from '../tracker/outbox.ts';
import { pct, price, ts } from '../util/format.ts';
import { localDay } from '../util/time.ts';
import type { WalletFileReport } from '../wallets/file.ts';
import { catchUpEmbed, importFinishedEmbed, transferEmbed, walletFileEmbed } from './embeds/notifications.ts';
import { dailySummaryEmbed } from './embeds/portfolio.ts';
import { base, coinIcon, COLORS, footer, safe } from './theme.ts';

const log = createLogger('outbox');

function alertEmbed(a: AlertRow, q: Quote): EmbedBuilder {
  const info = ASSETS[a.asset];
  const e = base(a.condition === 'above' ? COLORS.success : COLORS.danger)
    .setAuthor({ name: info.name, iconURL: coinIcon(a.asset) })
    .setTitle(`Price Alert: ${info.symbol} ${a.condition === 'above' ? 'above' : 'below'} ${price(a.target)}`)
    .setDescription(`${info.name} is now **${price(q.price)}**.`)
    .addFields(
      { name: 'Target', value: `${a.condition === 'above' ? 'Above' : 'Below'} ${price(a.target)}`, inline: true },
      { name: 'Current Price', value: price(q.price), inline: true },
      { name: '24h Change', value: pct(q.change24hPct), inline: true },
      { name: 'Alert', value: `#${a.id}${a.repeat ? ' (repeats)' : ' (one-time, now finished)'}`, inline: true },
      { name: 'Created', value: ts(a.created_at, 'D'), inline: true },
    );
  if (a.note) e.addFields({ name: 'Note', value: safe(a.note, 200) });
  return footer(e, 'Manage alerts with /alert').setTimestamp(new Date());
}

/** Delivers tracker messages to Discord: a channel, or the owners' DMs. */
class DiscordOutbox implements Outbox {
  private client: Client | null = null;

  attach(client: Client): void {
    this.client = client;
  }

  private async deliver(dest: Destination, embeds: EmbedBuilder[]): Promise<boolean> {
    const client = this.client;
    if (!client?.isReady()) return false;
    const owners = [...getConfig().ownerIds];
    const payload: MessageCreateOptions = { embeds, allowedMentions: { parse: [] } };

    if (dest.channelId) {
      try {
        const channel = await client.channels.fetch(dest.channelId);
        if (channel && channel.isSendable()) {
          if (dest.mention && owners.length) {
            payload.content = owners.map((id) => `<@${id}>`).join(' ');
            payload.allowedMentions = { users: owners };
          }
          await channel.send(payload);
          return true;
        }
        log.warn(`notification channel ${dest.channelId} is not a sendable channel; falling back to DMs`);
      } catch (err) {
        log.warn(`could not post to channel ${dest.channelId}; falling back to DMs`, err);
      }
      delete payload.content;
      payload.allowedMentions = { parse: [] };
    }

    let delivered = false;
    for (const id of owners) {
      try {
        const user = await client.users.fetch(id);
        await user.send(payload);
        delivered = true;
      } catch (err) {
        log.warn(`could not DM owner ${id} (are DMs from server members disabled?)`, err);
      }
    }
    return delivered;
  }

  transfer(n: TransferNotice, dest: Destination): Promise<boolean> {
    return this.deliver(dest, [transferEmbed(n)]);
  }

  catchUp(wallet: WalletNetworkJoined, items: TransferWithWallet[], dest: Destination): Promise<boolean> {
    return this.deliver(dest, [catchUpEmbed(wallet, items)]);
  }

  priceAlert(alert: AlertRow, quote: Quote, dest: Destination): Promise<boolean> {
    // Re-read in case it was removed in the meantime.
    if (!alertRepo.get(alert.id)) return Promise.resolve(true);
    return this.deliver(dest, [alertEmbed(alert, quote)]);
  }

  async dailySummary(dest: Destination): Promise<boolean> {
    if (!wallets.list().length) return true;
    const p = await buildPortfolio();
    const now = Math.floor(Date.now() / 1000);
    const day = flowReport(now - 86_400, now + 1);
    const prev = snapshots.before(localDay(getConfig().timezone));
    return this.deliver(dest, [dailySummaryEmbed(p, prev, day)]);
  }

  importFinished(n: ImportNotice, dest: Destination): Promise<boolean> {
    return this.deliver(dest, [importFinishedEmbed(n)]);
  }

  walletFileSynced(r: WalletFileReport, dest: Destination): Promise<boolean> {
    return this.deliver(dest, [walletFileEmbed(r)]);
  }
}

export const outbox = new DiscordOutbox();
