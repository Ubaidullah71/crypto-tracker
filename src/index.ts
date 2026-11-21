import { Events, type Client } from 'discord.js';
import { getConfig, requireDiscordConfig } from './config.ts';
import { closeDb, openDb } from './db/database.ts';
import { createClient, syncCommands } from './discord/bot.ts';
import { outbox } from './discord/outbox.ts';
import { log, registerSecret, setLogLevel } from './logger.ts';
import { getPriceService } from './prices/prices.ts';
import { backfills } from './tracker/backfill.ts';
import { jobs } from './tracker/jobs.ts';
import { notifier } from './tracker/notifier.ts';
import { tracker } from './tracker/tracker.ts';
import { closeHttp } from './util/http.ts';
import { getSettings, migrateSettings } from './settings.ts';
import {
  ensureWalletFile,
  reportHasChanges,
  stopWatchingWalletFile,
  syncWalletFile,
  watchWalletFile,
  type WalletFileReport,
} from './wallets/file.ts';

let client: Client | null = null;
let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down...');
  const force = setTimeout(() => process.exit(code), 10_000);
  force.unref();
  try {
    stopWatchingWalletFile();
    tracker.stop();
    backfills.stop();
    jobs.stop();
    await client?.destroy();
    await closeHttp();
    closeDb();
  } catch (err) {
    log.error('error during shutdown', err);
  }
  process.exit(code);
}

async function main(): Promise<void> {
  const cfg = getConfig();
  setLogLevel(cfg.logLevel);
  registerSecret(cfg.discordToken);
  for (const k of cfg.etherscanApiKeys) registerSecret(k);
  for (const p of cfg.proxyUrls) registerSecret(p);
  requireDiscordConfig(cfg);

  openDb(cfg.databasePath);
  migrateSettings();
  log.info(`database ready at ${cfg.databasePath}`);

  client = createClient();
  const ready = new Promise<Client<true>>((resolve) => client!.once(Events.ClientReady, resolve));
  await client.login(cfg.discordToken);
  const readyClient = await ready;

  await syncCommands(readyClient).catch((err) => log.error('could not register slash commands', err));

  outbox.attach(readyClient);
  notifier.setOutbox(outbox);
  backfills.setOutbox(outbox);
  jobs.setOutbox(outbox);

  void getPriceService()
    .getQuotes()
    .catch((err) => log.warn('initial price fetch failed', err));
  tracker.start();
  backfills.resumeAll();
  jobs.start();
  log.info(
    `ready. Owners: ${cfg.ownerIds.size}, time zone: ${cfg.timezone}, Etherscan keys: ${cfg.etherscanApiKeys.length}, ` +
      `connections: ${cfg.proxyUrls.length ? `${cfg.proxyIncludeDirect ? 'direct + ' : ''}${cfg.proxyUrls.length * cfg.proxySlots} proxy route(s)` : 'direct'}`,
  );

  // Wallets listed in wallets.txt are tracked automatically (at start and whenever the file is saved).
  ensureWalletFile();
  const announce = (r: WalletFileReport) => {
    if (!reportHasChanges(r)) return;
    const s = getSettings();
    void outbox
      .walletFileSynced(r, { channelId: s.notifyChannelId, mention: false })
      .catch((err) => log.warn('could not post wallet file summary', err));
  };
  void syncWalletFile()
    .then(announce)
    .catch((err) => log.warn('wallet file sync failed', err));
  watchWalletFile(announce);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', err));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
  void shutdown(1);
});

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  void shutdown(1);
});
