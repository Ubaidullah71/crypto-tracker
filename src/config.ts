import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');

const bool = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => !['0', 'false', 'no', 'off'].includes(v));

const schema = z.object({
  DISCORD_TOKEN: z.string().trim().default(''),
  DISCORD_CLIENT_ID: z.string().trim().default(''),
  DISCORD_GUILD_ID: z.string().trim().default(''),
  OWNER_IDS: z.string().trim().default(''),
  /** One key, or several separated by commas. */
  ETHERSCAN_API_KEY: z.string().trim().default(''),
  ETHERSCAN_API_KEYS: z.string().trim().default(''),
  TIMEZONE: z.string().trim().default('UTC'),
  /** One proxy, or several separated by commas / spaces / new lines. */
  PROXY_URL: z.string().trim().default(''),
  PROXY_URLS: z.string().trim().default(''),
  /** Independent connections per proxy (rotating gateways give each one its own exit IP). */
  PROXY_SLOTS: z.coerce.number().int().min(1).max(10).default(1),
  /** Also use your own connection alongside the proxies. */
  PROXY_INCLUDE_DIRECT: bool.default(true),
  HTTP_RATE_MULTIPLIER: z.coerce.number().min(0.1).max(3).default(1),
  DATABASE_PATH: z.string().trim().default('./data/portfolio.db'),
  WALLETS_FILE: z.string().trim().default('./wallets.txt'),
  /** Stop a history import after this many transactions per wallet network (protects free APIs). */
  MAX_HISTORY_TRANSACTIONS: z.coerce.number().int().min(100).max(1_000_000).default(50_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | null;
  ownerIds: ReadonlySet<string>;
  /** All Etherscan keys (requests rotate between them). */
  etherscanApiKeys: string[];
  /** First key, or null (kept for convenience). */
  etherscanApiKey: string | null;
  timezone: string;
  /** Proxies for blockchain/price API requests (never Discord). */
  proxyUrls: string[];
  /** First proxy or null (kept for convenience). */
  proxyUrl: string | null;
  proxySlots: number;
  proxyIncludeDirect: boolean;
  httpRateMultiplier: number;
  databasePath: string;
  /** Text file listing wallets to track automatically. */
  walletsFile: string;
  /** History import limit per wallet network. */
  maxHistoryTransactions: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

let cached: AppConfig | null = null;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function splitList(...values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) for (const part of v.split(/[\s,;]+/)) if (part.trim()) out.push(part.trim());
  return [...new Set(out)];
}

/** Loads configuration from the environment (and .env when present). Never logs secret values. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile) && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    process.loadEnvFile(envFile);
  }
  const env = schema.parse(process.env);

  const proxyUrls = splitList(env.PROXY_URL, env.PROXY_URLS);
  proxyUrls.forEach((p, i) => {
    let u: URL;
    try {
      u = new URL(p);
    } catch {
      throw new Error(`Proxy #${i + 1} in PROXY_URL/PROXY_URLS is not a valid URL (expected http://user:pass@host:port)`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Proxy #${i + 1} must use http:// or https:// (SOCKS is not supported)`);
    }
  });

  const keys = splitList(env.ETHERSCAN_API_KEY, env.ETHERSCAN_API_KEYS);
  const badKeys = keys.filter((k) => !/^[A-Za-z0-9]{20,64}$/.test(k)).length;
  if (badKeys) throw new Error(`${badKeys} Etherscan API key(s) in .env do not look like keys (letters and digits only)`);

  if (!isValidTimeZone(env.TIMEZONE)) {
    throw new Error(`TIMEZONE "${env.TIMEZONE}" is not a valid IANA time zone (example: Asia/Kolkata)`);
  }

  const ownerIds = env.OWNER_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  cached = {
    discordToken: env.DISCORD_TOKEN,
    discordClientId: env.DISCORD_CLIENT_ID,
    discordGuildId: env.DISCORD_GUILD_ID || null,
    ownerIds: new Set(ownerIds),
    etherscanApiKeys: keys,
    etherscanApiKey: keys[0] ?? null,
    timezone: env.TIMEZONE,
    proxyUrls,
    proxyUrl: proxyUrls[0] ?? null,
    proxySlots: env.PROXY_SLOTS,
    proxyIncludeDirect: proxyUrls.length === 0 ? true : env.PROXY_INCLUDE_DIRECT,
    httpRateMultiplier: env.HTTP_RATE_MULTIPLIER,
    databasePath: resolve(process.cwd(), env.DATABASE_PATH),
    walletsFile: resolve(process.cwd(), env.WALLETS_FILE),
    maxHistoryTransactions: env.MAX_HISTORY_TRANSACTIONS,
    logLevel: env.LOG_LEVEL,
  };
  return cached;
}

/** Validates the settings that are only required to run the Discord bot. */
export function requireDiscordConfig(cfg: AppConfig = getConfig()): void {
  const problems: string[] = [];
  if (!cfg.discordToken) problems.push('DISCORD_TOKEN is empty');
  if (!snowflake.safeParse(cfg.discordClientId).success) problems.push('DISCORD_CLIENT_ID must be your application ID');
  if (cfg.discordGuildId && !snowflake.safeParse(cfg.discordGuildId).success) problems.push('DISCORD_GUILD_ID must be a server ID');
  if (cfg.ownerIds.size === 0) problems.push('OWNER_IDS must contain at least one Discord user ID');
  for (const id of cfg.ownerIds) {
    if (!snowflake.safeParse(id).success) problems.push(`OWNER_IDS contains an invalid ID: "${id}"`);
  }
  if (problems.length) {
    throw new Error(`Configuration problems in .env:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Test helper: override configuration. */
export function setConfigForTests(partial: Partial<AppConfig>): void {
  const key = process.env.ETHERSCAN_API_KEY || null;
  cached = {
    discordToken: '',
    discordClientId: '',
    discordGuildId: null,
    ownerIds: new Set(),
    etherscanApiKeys: key ? [key] : [],
    etherscanApiKey: key,
    timezone: 'UTC',
    proxyUrls: [],
    proxyUrl: null,
    proxySlots: 1,
    proxyIncludeDirect: true,
    httpRateMultiplier: 1,
    databasePath: ':memory:',
    walletsFile: resolve(process.cwd(), 'wallets.test.txt'),
    maxHistoryTransactions: 50_000,
    logLevel: 'error',
    ...partial,
  };
}
