/** Coins the bot understands. Values are aggregated per coin across networks (e.g. USDT on 4 chains). */
export const ASSET_IDS = ['BTC', 'LTC', 'ETH', 'BNB', 'POL', 'SOL', 'XRP', 'USDT', 'USDC'] as const;
export type AssetId = (typeof ASSET_IDS)[number];

export interface BinanceSymbol {
  symbol: string;
  /** Unix ms from which this market has data (used to pick the right symbol for old timestamps). */
  since: number;
}

export interface AssetInfo {
  id: AssetId;
  name: string;
  symbol: string;
  coingeckoId: string;
  /** Binance USDT markets, newest first. Empty for USDT itself (price is 1). */
  binance: BinanceSymbol[];
  /** Coinbase Exchange products (USD), newest first. */
  coinbase: string[];
  stablecoin: boolean;
  /** Brand color used for embeds. */
  color: number;
  /** Fallback icon if CoinGecko image metadata is unavailable. */
  icon: string;
}

const cg = (path: string) => `https://coin-images.coingecko.com/coins/images/${path}`;

export const ASSETS: Record<AssetId, AssetInfo> = {
  BTC: {
    id: 'BTC',
    name: 'Bitcoin',
    symbol: 'BTC',
    coingeckoId: 'bitcoin',
    binance: [{ symbol: 'BTCUSDT', since: Date.UTC(2017, 7, 17) }],
    coinbase: ['BTC-USD'],
    stablecoin: false,
    color: 0xf7931a,
    icon: cg('1/large/bitcoin.png'),
  },
  LTC: {
    id: 'LTC',
    name: 'Litecoin',
    symbol: 'LTC',
    coingeckoId: 'litecoin',
    binance: [{ symbol: 'LTCUSDT', since: Date.UTC(2017, 11, 13) }],
    coinbase: ['LTC-USD'],
    stablecoin: false,
    color: 0x345d9d,
    icon: cg('2/large/litecoin.png'),
  },
  ETH: {
    id: 'ETH',
    name: 'Ethereum',
    symbol: 'ETH',
    coingeckoId: 'ethereum',
    binance: [{ symbol: 'ETHUSDT', since: Date.UTC(2017, 7, 17) }],
    coinbase: ['ETH-USD'],
    stablecoin: false,
    color: 0x627eea,
    icon: cg('279/large/ethereum.png'),
  },
  BNB: {
    id: 'BNB',
    name: 'BNB',
    symbol: 'BNB',
    coingeckoId: 'binancecoin',
    binance: [{ symbol: 'BNBUSDT', since: Date.UTC(2017, 10, 6) }],
    coinbase: [],
    stablecoin: false,
    color: 0xf3ba2f,
    icon: cg('825/large/bnb-icon2_2x.png'),
  },
  POL: {
    id: 'POL',
    name: 'Polygon',
    symbol: 'POL',
    coingeckoId: 'polygon-ecosystem-token',
    // MATIC migrated 1:1 to POL in September 2024.
    binance: [
      { symbol: 'POLUSDT', since: Date.UTC(2024, 8, 13) },
      { symbol: 'MATICUSDT', since: Date.UTC(2019, 3, 26) },
    ],
    coinbase: ['POL-USD', 'MATIC-USD'],
    stablecoin: false,
    color: 0x8247e5,
    icon: cg('32440/large/polygon.png'),
  },
  SOL: {
    id: 'SOL',
    name: 'Solana',
    symbol: 'SOL',
    coingeckoId: 'solana',
    binance: [{ symbol: 'SOLUSDT', since: Date.UTC(2020, 7, 11) }],
    coinbase: ['SOL-USD'],
    stablecoin: false,
    color: 0x9945ff,
    icon: cg('4128/large/solana.png'),
  },
  XRP: {
    id: 'XRP',
    name: 'XRP',
    symbol: 'XRP',
    coingeckoId: 'ripple',
    binance: [{ symbol: 'XRPUSDT', since: Date.UTC(2018, 4, 4) }],
    coinbase: ['XRP-USD'],
    stablecoin: false,
    color: 0x23292f,
    icon: cg('44/large/xrp-symbol-white-128.png'),
  },
  USDT: {
    id: 'USDT',
    name: 'Tether',
    symbol: 'USDT',
    coingeckoId: 'tether',
    binance: [],
    coinbase: [],
    stablecoin: true,
    color: 0x26a17b,
    icon: cg('325/large/Tether.png'),
  },
  USDC: {
    id: 'USDC',
    name: 'USD Coin',
    symbol: 'USDC',
    coingeckoId: 'usd-coin',
    binance: [{ symbol: 'USDCUSDT', since: Date.UTC(2018, 11, 15) }],
    coinbase: [],
    stablecoin: true,
    color: 0x2775ca,
    icon: cg('6319/large/usdc.png'),
  },
};

export function isAssetId(v: string): v is AssetId {
  return (ASSET_IDS as readonly string[]).includes(v);
}

export function parseAssetId(input: string): AssetId | null {
  const v = input.trim().toUpperCase();
  if (isAssetId(v)) return v;
  const aliases: Record<string, AssetId> = {
    BITCOIN: 'BTC',
    LITECOIN: 'LTC',
    ETHER: 'ETH',
    ETHEREUM: 'ETH',
    BINANCE: 'BNB',
    BNBCOIN: 'BNB',
    MATIC: 'POL',
    POLYGON: 'POL',
    SOLANA: 'SOL',
    RIPPLE: 'XRP',
    TETHER: 'USDT',
    USDT0: 'USDT',
    'USDC.E': 'USDC',
  };
  return aliases[v] ?? null;
}
