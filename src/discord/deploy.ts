/**
 * Manually (re)registers slash commands. The bot also does this automatically on start
 * whenever the command definitions change, so this is only needed for troubleshooting.
 *   npm run deploy-commands            -> guild (if DISCORD_GUILD_ID is set) or global
 *   npm run deploy-commands -- --clear -> remove all commands in that scope
 */
import { REST, Routes } from 'discord.js';
import { getConfig, requireDiscordConfig } from '../config.ts';
import { commandPayload } from './commands/index.ts';

const cfg = getConfig();
requireDiscordConfig(cfg);
const clear = process.argv.includes('--clear');
const rest = new REST({ version: '10' }).setToken(cfg.discordToken);
const route = cfg.discordGuildId
  ? Routes.applicationGuildCommands(cfg.discordClientId, cfg.discordGuildId)
  : Routes.applicationCommands(cfg.discordClientId);
const body = clear ? [] : commandPayload();
await rest.put(route, { body });
console.log(
  `${clear ? 'Cleared' : 'Registered'} ${body.length} commands (${cfg.discordGuildId ? `server ${cfg.discordGuildId}` : 'global'}).`,
);
