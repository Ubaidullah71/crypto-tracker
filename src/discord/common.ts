import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type ModalSubmitInteraction,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { ASSET_IDS, ASSETS } from '../core/assets.ts';
import { wallets, type WalletRow } from '../db/repo.ts';
import { getSettings } from '../settings.ts';
import { base, COLORS, footer } from './theme.ts';

export type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export interface Command {
  data: SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder | { name: string; toJSON(): unknown };
  execute(i: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(i: AutocompleteInteraction): Promise<void>;
  /** Handlers for component custom IDs of the form "<prefix>:<arg>:<arg>..." */
  components?: Record<string, (i: ComponentInteraction, args: string[]) => Promise<void>>;
}

/** Replies are private (ephemeral) in servers when the privacy setting is on. DMs are always private. */
export function privateFlag(i: { inGuild(): boolean }): MessageFlags.Ephemeral | undefined {
  return i.inGuild() && getSettings().privateReplies ? MessageFlags.Ephemeral : undefined;
}

export async function defer(i: ChatInputCommandInteraction): Promise<void> {
  const flags = privateFlag(i);
  await i.deferReply(flags ? { flags } : {});
}

export function errorEmbed(message: string, title = 'Something went wrong'): EmbedBuilder {
  return footer(base(COLORS.danger).setTitle(title).setDescription(message));
}

export function successEmbed(title: string, message: string): EmbedBuilder {
  return footer(base(COLORS.success).setTitle(title).setDescription(message));
}

export function infoEmbed(title: string, message: string): EmbedBuilder {
  return footer(base(COLORS.brand).setTitle(title).setDescription(message));
}

/** Sends (or edits, when deferred) a reply with embeds. */
export async function respond(
  i: ChatInputCommandInteraction | ComponentInteraction,
  payload: { embeds: EmbedBuilder[]; components?: unknown[]; files?: unknown[] },
): Promise<void> {
  const body = { embeds: payload.embeds, components: (payload.components ?? []) as never[], files: (payload.files ?? []) as never[] };
  if (i.deferred || i.replied) await i.editReply(body);
  else {
    const flags = privateFlag(i);
    await i.reply(flags ? { ...body, flags } : body);
  }
}

export async function fail(i: ChatInputCommandInteraction | ComponentInteraction, message: string, title?: string): Promise<void> {
  const embed = errorEmbed(message, title);
  if (i.deferred || i.replied) await i.editReply({ embeds: [embed], components: [] });
  else {
    const flags = privateFlag(i);
    await i.reply(flags ? { embeds: [embed], flags } : { embeds: [embed] });
  }
}

/** Plain-text reply that follows the privacy setting. */
export async function replyText(i: ComponentInteraction, content: string): Promise<void> {
  if (!i.isRepliable()) return;
  const flags = privateFlag(i);
  await i.reply(flags ? { content, flags } : { content });
}

export function findWallet(label: string): WalletRow | undefined {
  const w = wallets.byLabel(label);
  if (w) return w;
  // Autocomplete passes the id as "id:<n>".
  const m = /^id:(\d+)$/.exec(label);
  return m ? wallets.get(Number(m[1])) : undefined;
}

export async function autocompleteWallet(i: AutocompleteInteraction): Promise<void> {
  const q = String(i.options.getFocused()).toLowerCase();
  const items = wallets
    .list()
    .filter((w) => w.label.toLowerCase().includes(q) || w.address.toLowerCase().includes(q))
    .slice(0, 25)
    .map((w) => ({ name: `${w.label}  (${w.address.slice(0, 10)}...${w.address.slice(-6)})`.slice(0, 100), value: w.label.slice(0, 100) }));
  await i.respond(items);
}

export const COIN_CHOICES = ASSET_IDS.map((a) => ({ name: `${ASSETS[a].name} (${a})`, value: a }));
