import { ApplicationIntegrationType, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import type { Command, ComponentInteraction } from '../common.ts';
import { alertCommand } from './alerts.ts';
import { coinCommand, portfolioCommand, priceCommand } from './portfolio.ts';
import { exportCommand, reportCommand } from './reports.ts';
import { settingsCommand } from './settings.ts';
import { helpCommand } from './help.ts';
import { statusCommand } from './status.ts';
import { transactionsCommand, txCommand } from './transactions.ts';
import { walletCommand } from './wallet.ts';

export const COMMANDS: Command[] = [
  walletCommand,
  portfolioCommand,
  coinCommand,
  priceCommand,
  transactionsCommand,
  txCommand,
  reportCommand,
  exportCommand,
  alertCommand,
  settingsCommand,
  statusCommand,
  helpCommand,
];

export const commandsByName = new Map(COMMANDS.map((c) => [c.data.name, c]));

export const componentHandlers = new Map<string, (i: ComponentInteraction, args: string[]) => Promise<void>>();
for (const c of COMMANDS) {
  for (const [prefix, handler] of Object.entries(c.components ?? {})) {
    if (componentHandlers.has(prefix)) throw new Error(`Duplicate component prefix "${prefix}"`);
    componentHandlers.set(prefix, handler);
  }
}

/**
 * Command JSON for registration. Commands are hidden from non-administrators in servers
 * (an extra layer on top of the owner check) and usable in servers and the bot's DMs.
 */
export function commandPayload(): unknown[] {
  return COMMANDS.map((c) => {
    const json = c.data.toJSON() as Record<string, unknown>;
    return {
      ...json,
      default_member_permissions: PermissionFlagsBits.Administrator.toString(),
      contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
      integration_types: [ApplicationIntegrationType.GuildInstall],
    };
  });
}
