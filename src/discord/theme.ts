import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { ASSETS, type AssetId } from '../core/assets.ts';
import { getNetworkAsset, NETWORKS, type NetworkId } from '../core/networks.ts';
import { getPriceService } from '../prices/prices.ts';
import { isExtendedKey, shortKey } from '../core/xpub.ts';
import { truncate } from '../util/format.ts';

/** Restrained palette: status colors only, no decorative symbols anywhere. */
export const COLORS = {
  pending: 0xf0b232,
  success: 0x23a55a,
  outgoing: 0x4f7cff,
  danger: 0xda373c,
  warning: 0xe67e22,
  brand: 0x3b4bdb,
  neutral: 0x2b2d31,
  muted: 0x80848e,
} as const;

export const BOT_NAME = 'Crypto Portfolio';

/**
 * A thin full-width bar in the embed's own color. Discord sizes an embed to its widest element,
 * so this makes every embed the same width regardless of its content.
 */
export function widthBarUrl(color: number): string {
  const hex = color.toString(16).padStart(6, '0').toUpperCase();
  return `https://dummyimage.com/1000x12/${hex}/${hex}.png`;
}

export function base(color: number = COLORS.brand): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setImage(widthBarUrl(color));
}

export function footer(e: EmbedBuilder, text?: string): EmbedBuilder {
  // Keep the width bar in sync with the final color.
  const color = e.data.color;
  if (typeof color === 'number' && !e.data.image?.url?.startsWith('attachment://')) e.setImage(widthBarUrl(color));
  return e.setFooter({ text: text ? `${BOT_NAME}  |  ${text}` : BOT_NAME });
}

export function coinIcon(asset: AssetId): string {
  return getPriceService().icon(asset);
}

/** "Tether (USDT) on BNB Smart Chain", "Litecoin" */
export function assetTitle(assetKey: string): string {
  const na = getNetworkAsset(assetKey);
  if (!na) return assetKey;
  const info = ASSETS[na.asset];
  const net = NETWORKS[na.network];
  if (na.kind === 'native' && net.native.asset === na.asset && (na.network !== 'base' || na.asset !== 'ETH')) {
    return info.name;
  }
  const sym = na.label ?? info.symbol;
  return `${info.name} (${sym}) on ${net.name}`;
}

export function networkName(n: NetworkId): string {
  return NETWORKS[n].name;
}

/**
 * Escapes user/chain/API supplied text for embeds and keeps it short. Masked links, headings and
 * lists are escaped too, so remote text (e.g. an RPC error message) can never render as a
 * disguised clickable link.
 */
export function safe(text: string, max = 200): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ');
  const escaped = escapeMarkdown(truncate(cleaned, max), { maskedLink: true, heading: true, bulletedList: true, numberedList: true });
  // Neutralize any remaining link syntax and angle-bracket autolinks.
  return escaped.replace(/\]\(/g, ']\\(').replace(/</g, '\\<');
}

/** Addresses and transaction ids are plain alphanumerics (0x prefix included). */
const SAFE_ID = /^[A-Za-z0-9]{20,140}$/;

/** Markdown link to an explorer page; falls back to plain text for unexpected values. */
export function explorerLink(label: string, url: string): string {
  return `[${label.replace(/[[\]()]/g, '')}](${url})`;
}

export function addressLink(network: NetworkId, address: string, short = false): string {
  // An account key (xpub) has no explorer page; show it shortened as plain text.
  if (isExtendedKey(address)) return `Account key ${shortKey(address)}`;
  // Never echo an unexpected value: it could be a crafted link or formula from a hostile API.
  if (!SAFE_ID.test(address)) return 'unrecognized address';
  const label = short && address.length > 16 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
  return explorerLink(label, NETWORKS[network].explorer.address(address));
}

export function txLink(network: NetworkId, txid: string, short = false): string {
  if (!SAFE_ID.test(txid)) return txid.startsWith('block:') ? `internal transfer (${safe(txid, 40)})` : 'unrecognized transaction';
  const label = short && txid.length > 20 ? `${txid.slice(0, 10)}...${txid.slice(-8)}` : txid;
  return explorerLink(label, NETWORKS[network].explorer.tx(txid));
}

/** Two-line "Amount" cell like "$300.01 USD\n(5.76036866 LTC)". */
export function usdAndCoin(usdText: string, coinText: string): string {
  return `${usdText} USD\n(${coinText})`;
}

/**
 * Discord field values hold 1024 characters. Long text is cut at a line break (never inside a
 * link) and an open code block is closed again.
 */
export function fieldValue(text: string): string {
  if (!text) return '​';
  if (text.length <= 1024) return text;
  let cut = text.slice(0, 1000);
  const nl = cut.lastIndexOf('\n');
  if (nl > 200) cut = cut.slice(0, nl);
  if ((cut.match(/```/g)?.length ?? 0) % 2 === 1) cut += '\n```';
  return `${cut}\n...`;
}

/** Characters counted toward Discord's 6000-character embed total. */
export function embedLength(e: EmbedBuilder): number {
  const j = e.toJSON();
  let n = (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0) + (j.author?.name.length ?? 0);
  for (const f of j.fields ?? []) n += f.name.length + f.value.length;
  return n;
}

/**
 * Adds fields while staying under Discord's limits (25 fields, 6000 characters in total, with
 * room left for a footer). Fields that do not fit are summarized in one closing note.
 */
export function addFieldsCapped(
  e: EmbedBuilder,
  fields: Array<{ name: string; value: string; inline?: boolean }>,
  overflowNote: (hidden: number) => string,
  budget = 5600,
): void {
  let used = embedLength(e);
  const existing = e.toJSON().fields?.length ?? 0;
  for (let k = 0; k < fields.length; k++) {
    const f = fields[k]!;
    const size = f.name.length + f.value.length;
    const fieldsLeft = 25 - existing - k;
    const isLastFitting = fieldsLeft <= 1 && k < fields.length - 1;
    if (used + size > budget || isLastFitting) {
      e.addFields({ name: 'More', value: overflowNote(fields.length - k) });
      return;
    }
    e.addFields(f);
    used += size;
  }
}
