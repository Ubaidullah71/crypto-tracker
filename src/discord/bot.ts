import { createHash } from 'node:crypto';
import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, type Interaction } from 'discord.js';
import { getConfig } from '../config.ts';
import { getSetting, setSetting } from '../db/repo.ts';
import { createLogger, redact } from '../logger.ts';
import { fail } from './common.ts';
import { commandPayload, commandsByName, componentHandlers } from './commands/index.ts';

const log = createLogger('discord');

const refusedRecently = new Map<string, number>();

function isOwner(userId: string): boolean {
  return getConfig().ownerIds.has(userId);
}

async function refuse(i: Interaction): Promise<void> {
  const last = refusedRecently.get(i.user.id) ?? 0;
  if (Date.now() - last > 60_000) {
    log.warn(`refused interaction from non-owner ${i.user.id}`);
    refusedRecently.set(i.user.id, Date.now());
  }
  if (i.isAutocomplete()) return i.respond([]).catch(() => undefined);
  if (i.isRepliable()) {
    await i.reply({ content: 'This is a private bot.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

async function handle(i: Interaction): Promise<void> {
  if (!isOwner(i.user.id)) return refuse(i);

  if (i.isChatInputCommand()) {
    const cmd = commandsByName.get(i.commandName);
    if (!cmd) return;
    try {
      await cmd.execute(i);
    } catch (err) {
      log.error(`/${i.commandName} failed`, err);
      await fail(i, 'The command failed unexpectedly. Details were written to the bot log.').catch(() => undefined);
    }
    return;
  }

  if (i.isAutocomplete()) {
    const cmd = commandsByName.get(i.commandName);
    await cmd?.autocomplete?.(i).catch((err) => log.debug('autocomplete failed', err));
    return;
  }

  if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) {
    const [prefix, ...args] = i.customId.split(':');
    const handler = prefix ? componentHandlers.get(prefix) : undefined;
    if (!handler) return;
    try {
      await handler(i, args);
    } catch (err) {
      log.error(`component ${prefix} failed`, err);
      await fail(i, 'That action failed unexpectedly. Details were written to the bot log.').catch(() => undefined);
    }
  }
}

/** Registers slash commands when their definition changed since the last start. */
export async function syncCommands(client: Client<true>): Promise<void> {
  const cfg = getConfig();
  const body = commandPayload();
  const scope = cfg.discordGuildId ? `guild:${cfg.discordGuildId}` : 'global';
  const hash = createHash('sha256').update(JSON.stringify({ scope, body })).digest('hex');
  if (getSetting<string>('commandsHash') === hash) {
    log.info(`slash commands up to date (${scope})`);
    return;
  }
  const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
  const route = cfg.discordGuildId
    ? Routes.applicationGuildCommands(client.application.id, cfg.discordGuildId)
    : Routes.applicationCommands(client.application.id);
  await rest.put(route, { body });
  setSetting('commandsHash', hash);
  log.info(`registered ${body.length} slash commands (${scope})`);
}

export function createClient(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Never ping anyone unless a message explicitly allows it (on-chain data could contain "@everyone").
    allowedMentions: { parse: [] },
  });

  client.once(Events.ClientReady, (c) => {
    log.info(`logged in as ${c.user.tag}`);
    c.user.setPresence({ activities: [{ name: 'your wallets', type: ActivityType.Watching }], status: 'online' });
  });
  client.on(Events.InteractionCreate, (i) => {
    void handle(i).catch((err) => log.error('interaction handler crashed', err));
  });
  client.on(Events.Error, (err) => log.error('discord client error', err));
  client.on(Events.ShardError, (err) => log.warn(`gateway error: ${redact(err.message)}`));
  client.on(Events.ShardDisconnect, () => log.warn('gateway disconnected; discord.js will reconnect'));
  client.on(Events.ShardResume, () => log.info('gateway connection resumed'));
  return client;
}
