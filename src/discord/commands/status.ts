import { statSync } from 'node:fs';
import { SlashCommandBuilder } from 'discord.js';
import { getConfig } from '../../config.ts';
import { NETWORKS } from '../../core/networks.ts';
import { transfers, walletNetworks } from '../../db/repo.ts';
import { getPriceService } from '../../prices/prices.ts';
import { tracker } from '../../tracker/tracker.ts';
import { duration, plural, ts } from '../../util/format.ts';
import { allEndpointHealth, routeHealth } from '../../util/http.ts';
import { etherscanKeys } from '../../chains/evm/explorer.ts';
import { defer, respond, type Command } from '../common.ts';
import { base, COLORS, fieldValue, footer, safe } from '../theme.ts';
import { syncStatus } from './wallet.ts';

const startedAt = Math.floor(Date.now() / 1000);

export const statusCommand: Command = {
  data: new SlashCommandBuilder().setName('status').setDescription('Bot health: sync status, data providers, database'),
  async execute(i) {
    await defer(i);
    const wns = walletNetworks.all();
    const errors = wns.filter((w) => w.consecutive_errors >= 3);
    const importing = wns.filter((w) => w.backfill_status === 'running' || w.backfill_status === 'pending');
    const e = base(errors.length ? COLORS.warning : COLORS.success).setTitle('Bot Status');
    e.setDescription(
      errors.length ? `${plural(errors.length, 'wallet network')} cannot sync right now (see below).` : 'All systems normal.',
    );

    let dbSize = 'n/a';
    try {
      dbSize = `${(statSync(getConfig().databasePath).size / 1024 / 1024).toFixed(1)} MB`;
    } catch {
      /* ignore */
    }
    const priceAt = getPriceService().lastUpdated();
    e.addFields(
      { name: 'Uptime', value: duration(Math.floor(Date.now() / 1000) - startedAt), inline: true },
      {
        name: 'Tracking',
        value: `${plural(new Set(wns.map((w) => w.wallet_id)).size, 'wallet')}\n${plural(wns.length, 'network')}`,
        inline: true,
      },
      {
        name: 'Polls',
        value: `${tracker.stats.polls.toLocaleString('en-US')} done\n${tracker.stats.failures.toLocaleString('en-US')} failed`,
        inline: true,
      },
      { name: 'Stored Transactions', value: transfers.total().toLocaleString('en-US'), inline: true },
      { name: 'Database', value: dbSize, inline: true },
      { name: 'Prices Updated', value: priceAt ? ts(Math.floor(priceAt / 1000), 'R') : 'Not yet', inline: true },
    );
    if (wns.length) {
      e.addFields({
        name: 'Wallet Sync',
        value: fieldValue(wns.map((w) => `**${safe(w.label, 40)}** on ${NETWORKS[w.network].shortName}: ${syncStatus(w)}`).join('\n')),
      });
    }
    if (importing.length) {
      e.addFields({ name: 'History Imports', value: `${plural(importing.length, 'import')} running or queued.` });
    }
    const host = (url: string) => {
      try {
        return new URL(url).host;
      } catch {
        return url.slice(0, 60);
      }
    };
    const unhealthy = allEndpointHealth().flatMap((p) =>
      p.endpoints.filter((ep) => !ep.healthy).map((ep) => `${p.pool}: ${host(ep.url)} (${safe(ep.lastError ?? 'error', 80)})`),
    );
    e.addFields({
      name: 'Data Providers',
      value: fieldValue(
        unhealthy.length
          ? `Temporarily skipping (automatic failover active):\n${unhealthy.slice(0, 10).join('\n')}`
          : 'All providers responding.',
      ),
    });
    const cfg = getConfig();
    const routes = routeHealth();
    const proxies = routes.filter((r) => r.label !== 'direct');
    const downProxies = proxies.filter((r) => !r.healthy);
    const keys = etherscanKeys(cfg.etherscanApiKeys).health();
    const keyLine = keys.length
      ? `Etherscan keys: ${keys.filter((k) => k.status === 'ok').length} of ${keys.length} ready` +
        (keys.some((k) => k.status !== 'ok')
          ? ` (${keys
              .filter((k) => k.status !== 'ok')
              .map((k) => `#${k.index + 1} ${k.status}`)
              .join(', ')})`
          : '')
      : 'Etherscan keys: none (Ethereum uses Blockscout)';
    const routeLine = proxies.length
      ? `Connections: ${routes.some((r) => r.label === 'direct') ? 'direct + ' : ''}${plural(proxies.length, 'proxy route')}, ${proxies.length - downProxies.length} working` +
        (downProxies.length ? `\nResting: ${downProxies.map((r) => `${r.label} (${safe(r.lastError ?? 'error', 60)})`).join(', ')}` : '')
      : 'Connections: direct only (add PROXY_URLS in .env to speed up large imports)';
    e.addFields({ name: 'Connections', value: fieldValue(`${routeLine}\n${keyLine}`) });
    await respond(i, { embeds: [footer(e, `Node ${process.version}`).setTimestamp(new Date())] });
  },
};
