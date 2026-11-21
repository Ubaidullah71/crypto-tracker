# Crypto Portfolio

A self-hosted Discord bot that watches your crypto wallet **addresses**, notifies you the moment
money arrives or leaves, and keeps a full portfolio: holdings, average buy price, profit and loss,
reports and CSV exports.

- **Read-only.** It only uses public addresses. It never asks for, stores or needs a private key
  or recovery phrase, and it cannot move funds.
- **No tracking accounts.** Data comes straight from public blockchain APIs and nodes (plus an
  optional free Etherscan key). Your wallet list stays on your own machine.
- **Private by design.** Only the Discord users you list can use it. Everything is stored locally
  in SQLite.

> Not financial or tax advice. Numbers depend on public data sources and are provided without
> warranty; see [Accuracy](#accuracy).

## Contents

- [Features](#features)
- [Supported coins and networks](#supported-coins-and-networks)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Adding wallets](#adding-wallets)
- [Commands](#commands)
- [How profit and loss is calculated](#how-profit-and-loss-is-calculated)
- [Accuracy](#accuracy)
- [Limitations](#limitations)
- [Data sources and fair use](#data-sources-and-fair-use)
- [Running 24/7](#running-247)
- [Maintenance](#maintenance)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Features

- **Payment notifications**: a "Transaction Seen" message while a payment is unconfirmed, then
  "Transaction Confirmed" with amount (USD and coin), fee, fee rate, ETA, RBF flag, time taken,
  block, sender and your new balance. Outgoing, dropped and failed transactions are reported too.
  Messages go to a channel or your DMs, per wallet if you like.
- **Full history import** when a wallet is added (in the background, with automatic retries), so
  profit and loss is right from day one. Imported history never triggers notifications.
- **Portfolio**: total value, 24h change, holdings by coin, wallet and network, average buy price,
  invested amount, unrealized and realized profit/loss, fees paid. Average cost method.
- **Categories**: mark any transaction as a payment, purchase, sale, spend, transfer to or from
  your own wallet, or spam, and set the price you actually paid. Moves between wallets you track
  are recognised automatically.
- **Wallet file**: list all wallets in `wallets.txt`; changes are picked up on save.
- **Ledger, Trezor and Electrum accounts**: track a whole Bitcoin/Litecoin account from its
  xpub/ypub/zpub/Ltub key (every receive and change address).
- **Reports and exports**: money in and out per period, payments by type and coin, realized
  profit/loss, CSV for spreadsheets.
- **Daily summary** and **price alerts**.
- **Safety**: address-poisoning protection (dust sent from look-alike addresses is hidden from
  lists and alerts automatically; real payments from look-alikes carry a warning), spam token
  filtering, secrets never stored or logged.

## Supported coins and networks

| Coin | Networks |
| --- | --- |
| BTC | Bitcoin (addresses or account keys) |
| LTC | Litecoin (addresses or account keys) |
| ETH | Ethereum, Base |
| BNB | BNB Smart Chain |
| POL | Polygon |
| SOL | Solana |
| XRP | XRP Ledger |
| USDT | Ethereum, BNB Smart Chain, Polygon (USDT0), Base (bridged), Solana |
| USDC | Ethereum, BNB Smart Chain, Polygon (USDC and USDC.e), Base, Solana |

One `0x...` address is tracked on all four EVM networks at once (you can narrow it down).

## Quick start

Requirements: **Node.js 22.18 or newer** (24 recommended). Node runs the TypeScript sources
directly; there is no build step. No database server is needed (SQLite is built into Node).

### 1. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click
   **New Application**.
2. **Bot** tab: click **Reset Token** and copy it (`DISCORD_TOKEN`). Turn **Public Bot** off so
   nobody else can add it to their server. No privileged intents are needed.
3. **General Information**: copy the **Application ID** (`DISCORD_CLIENT_ID`).
4. **Installation** (or OAuth2 URL Generator): scopes `bot` and `applications.commands`; bot
   permissions **View Channels, Send Messages, Embed Links, Attach Files, Read Message History**.
   Open the link and add the bot to your own server.
5. In Discord, enable **Settings > Advanced > Developer Mode**. Right-click your name to copy your
   user ID (`OWNER_IDS`) and your server icon for the server ID (`DISCORD_GUILD_ID`).

### 2. Install and configure

```bash
git clone https://github.com/Ubaidullah71/crypto-tracker.git
cd crypto-tracker
npm ci --omit=dev
cp .env.example .env        # Windows: copy .env.example .env
```

Edit `.env`: at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `OWNER_IDS`, and preferably
`DISCORD_GUILD_ID`, `ETHERSCAN_API_KEY` (free at [etherscan.io](https://etherscan.io/apidashboard))
and `TIMEZONE`.

### 3. Run

```bash
npm start
```

Slash commands register automatically. On first start a `wallets.txt` template is created. Then
in Discord:

1. `/settings notifications channel:#payments` (or `dm:true`)
2. Add your wallets to `wallets.txt` (or use `/wallet add`)
3. `/portfolio`

`/help` explains everything inside Discord.

## Configuration

All settings live in `.env` (see `.env.example`). Never commit or share `.env`.

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `DISCORD_CLIENT_ID` | yes | Application ID. |
| `OWNER_IDS` | yes | Comma-separated Discord user IDs allowed to use the bot. Everyone else is refused. |
| `DISCORD_GUILD_ID` | no | Your server ID. Commands register there instantly. Empty = global (also usable in DMs). |
| `ETHERSCAN_API_KEY` | no | Free Etherscan key(s), comma-separated. Used for Ethereum and Polygon history (Blockscout is used without a key or when Etherscan fails). |
| `TIMEZONE` | no | IANA zone for the daily summary and reports, e.g. `Europe/Berlin`. Default `UTC`. |
| `WALLETS_FILE` | no | Wallet list file. Default `./wallets.txt`. |
| `DATABASE_PATH` | no | SQLite file. Default `./data/portfolio.db`. |
| `MAX_HISTORY_TRANSACTIONS` | no | History import limit per wallet and network. Default 50,000. |
| `PROXY_URLS` | no | Optional HTTP(S) proxies for blockchain and price requests (never Discord). See [Data sources](#data-sources-and-fair-use). |
| `PROXY_SLOTS` | no | Parallel connections per proxy (for rotating gateways). Default 1, max 10. |
| `PROXY_INCLUDE_DIRECT` | no | Also use your own connection when proxies are set. Default `true`. |
| `HTTP_RATE_MULTIPLIER` | no | Scale the built-in request rates (0.1 to 3). Keep 1 unless a provider allows more. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. |

In-Discord settings (`/settings`): notification destination, incoming/outgoing, "Seen" alerts,
minimum value, mentions, daily summary time, alert channel, confirmations per network, and
private replies (on by default; `/settings privacy private_replies:false` to show replies to the
whole channel on a personal server).

## Adding wallets

### wallets.txt (recommended)

One line per address, `Name = address`. The network is detected from the address. The addresses
below are shortened examples, not real ones; use your full addresses.

```text
Main BTC       = bc1qxy2kgdygjrsqtzq2............
Savings LTC    = ltc1qg82r6ml3rqk7v4a............
MetaMask       = 0x5aAeb6053F3E94C9b9A0............        # Ethereum, BNB Chain, Polygon and Base
Exchange BEP20 = 0x8617E340B3D01FA5F11F............ @ bsc  # only BNB Chain
Phantom        = 7EcDhSYGxXyscszYEp35KHN8............
XRP Main       = rPT1Sjq2YGrBMTttX4GZ............

# A whole Ledger/Trezor account (every receive and change address):
Ledger BTC     = xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhha............
# A Litecoin account that Ledger Live shows as "xpub":
Ledger LTC     = xpub6D4BDPcP2GT577Vvch3R8wDkScZWzQzMMUm3PWbmWvVJr............ @ litecoin
```

- Several addresses for one coin are several lines.
- Lines can share a name, for example the wallet app they belong to. The bot then adds the chain:
  three lines called `Exodus` (a BTC, a 0x and a Solana address) become Exodus BTC, Exodus EVM and
  Exodus SOL.
- `@` limits an EVM address to some networks: `bitcoin`, `litecoin`, `ethereum`, `bsc`,
  `polygon`, `base`, `solana`, `xrp`, `evm` (all four EVM networks).
- Changing a name renames the wallet; changing the `@` part adds networks. Commands such as
  `/wallet rename` and `/wallet networks` are not undone unless you edit that line.
- Removing a line never deletes a wallet or its history; use `/wallet remove`.
- Lines with problems (typos, private keys, recovery phrases) are skipped and reported by line
  number. A secret is never stored, logged or echoed.
- `/wallet sync` re-reads the file immediately.

**Account keys (xpub)**: Ledger Live (desktop): Accounts, open the account, wrench icon (Edit
account), Advanced, copy `xpub`. Trezor Suite: account Details, Show public key. Electrum: Wallet,
Information, Master Public Key. The key cannot spend funds but reveals the account's full
history: keep it as private as your address list. Do not also add single addresses that belong
to a tracked account (they would be counted twice).

### /wallet add

`/wallet add address:<address> label:<name> [network:<choice>]` does the same for one wallet.

## Commands

| Command | Purpose |
| --- | --- |
| `/wallet add`, `list`, `view`, `rename`, `remove` | Manage wallets |
| `/wallet notifications`, `networks` | Mute a wallet or send it to its own channel; choose EVM networks |
| `/wallet refresh`, `reimport`, `sync` | Sync now, import history again, re-read `wallets.txt` |
| `/portfolio` | Overview, by wallet, by network, coin drill-down |
| `/coin`, `/price` | One coin in depth; market prices |
| `/transactions` | History with wallet, coin, direction and period filters |
| `/tx view`, `/tx edit` | Details; category, your own price, note |
| `/report` | Money in and out, payments, fees and realized profit/loss for a period |
| `/export transactions`, `/export portfolio` | CSV files |
| `/alert add`, `list`, `remove` | Price alerts |
| `/settings` | Notifications, summary, alerts, confirmations, privacy |
| `/status` | Sync, data providers, connections and API keys |
| `/help` | Guide by topic |

## How profit and loss is calculated

Average cost per coin, pooled across all wallets and networks (the method CoinGecko uses):

- **Incoming** counts as bought at the market price at that time. Set your real price with
  `/tx edit price:` when it differs.
- **Outgoing** counts as sold at the market price, producing realized profit/loss.
- **Moves between tracked wallets** are recognised by pairing the sending and receiving side of
  the same transaction and have no effect. If only part of a payment went to another tracked
  wallet (for example change), only the rest counts as a sale.
- **Transfer to / from my own untracked wallet** (category): the coins are parked at their cost
  and come back at that cost.
- **Network fees** you pay are deducted at cost.
- **Invested** is the cost of what you hold now. **Profit/Loss** is value minus invested.
  **Realized** is profit already taken by selling or spending.
- Holdings always use the live on-chain balance.

## Accuracy

`npm run check-data` verifies, per wallet, network and coin, that the imported history adds up
exactly to the on-chain balance and that every transaction is priced. Things that affect the
numbers:

- **Historical prices** of imported transactions use hourly candles (average of open and close);
  expect a small difference from the exact minute in volatile hours. Live transactions use the
  price when they are detected.
- **USD** values are based on USDT markets (Binance) and CoinGecko, treated as dollars. USDT
  always counts as exactly $1; USDC uses its market price when one is available.
- **No market data** (for example XRP before May 2018) means the transaction counts at $0 cost
  until you set a price with `/tx edit`. `/coin` points these out.
- **Every incoming payment is a purchase** at market price and every outgoing one a sale, unless
  it went between two tracked wallets or you set a category. Sending coins to an exchange, a
  staking service or a wallet you do not track therefore realizes profit/loss; mark it as
  "Transfer to my own wallet" if you only moved the coins.
- **Bridges between networks** (for example ETH from Ethereum to Base, or USDC from Ethereum to
  Solana) are not recognised as moves, because the two sides are different transactions. Mark
  both sides "Between my tracked wallets" to keep your average cost.
- **Past periods can change** when older history or prices arrive later.
- **Not a tax tool.** One pooled average cost per coin; no FIFO/LIFO lots and no country-specific
  rules.

## Limitations

This is a personal tool built on free public services. Please read this before relying on it.

**Size of wallets and histories**

- The history import stops at **50,000 transactions per wallet and network**
  (`MAX_HISTORY_TRANSACTIONS`) and says so in the import message and `/status`. Anything beyond
  that is not imported,
  so profit/loss for that wallet is incomplete. The limit protects the free APIs from accidental
  imports of exchange or contract addresses; raise it and run `/wallet reimport` if you need to.
- It is built for personal wallets: tens of addresses, not thousands. All requests to a provider
  share one rate limit, so the more wallets you track on one network, the less often each one is
  checked. Very busy addresses (exchange hot wallets, popular contracts) import and poll slowly.
- Import time depends on the providers. A typical personal wallet takes seconds to a few
  minutes. On **BNB Chain and Base** (not covered by Etherscan's free plan) history is rebuilt by
  searching historical balances on public archive nodes: an address with thousands of
  transactions can take hours, and an import interrupted by a restart starts that search again.
- **Account keys (xpub)** find addresses with the standard gap limit of 20 unused addresses in a
  row (as Ledger Live and Trezor Suite do). Coins on an address beyond that gap are not seen.

**Notifications**

- Wallets are checked by polling, about every 30 s (Bitcoin), 20 s (Litecoin) and 15 s (other
  networks). Expect a delay of up to that interval plus the provider's own delay, more when a
  provider is slow or rate limiting.
- "Transaction Seen" (unconfirmed) is sent for Bitcoin, Litecoin and Solana. Ethereum, BNB Chain,
  Polygon, Base and XRP transactions are only visible to the bot once they are in a block, so the
  first message is "Transaction Confirmed" (after the configured confirmations on EVM networks).
- On BNB Chain and Base, a token that arrives and is pulled out again by a third-party contract
  (without a transaction from you) between two checks may be missed. Balances stay correct.
- Run one copy of the bot at a time. Everyone in `OWNER_IDS` shares the same wallets and
  portfolio; it is not a multi-user service.

**Addresses**

| Network | Supported | Not supported |
| --- | --- | --- |
| Bitcoin | Legacy `1...`, nested SegWit `3...`, native SegWit `bc1q...`, Taproot `bc1p...`; account keys xpub, ypub, zpub | Multisig account keys (Ypub, Zpub). Single multisig addresses work as normal addresses. |
| Litecoin | `L...`, `M...`, `ltc1...`; old-style `3...` with `@ litecoin`; account keys Ltub, Mtub, and xpub/zpub with `@ litecoin` | MWEB (`ltcmweb1...`) addresses; coins moved into MWEB show as sent |
| EVM | Any `0x...` address, including smart-contract wallets | Networks other than Ethereum, BNB Chain, Polygon and Base (Arbitrum, Optimism, Avalanche and so on) |
| Solana | Wallet (owner) addresses | Token account addresses on their own; SOL in stake accounts |
| XRP | Classic `r...` addresses | X-addresses. Destination tags are shown but not used to filter, so a shared exchange deposit address would track the whole exchange account |

Tron and other chains are not supported. Never add exchange deposit addresses that are shared
between customers.

**Coins and tokens**

- Only the coins in the table above. Other tokens, NFTs, Ordinals, Runes and BRC-20, wrapped coins
  (WETH, WBNB), liquidity and staking positions, and XRP Ledger issued currencies are ignored.
  Coins sent into such positions count as sold unless you mark them as a transfer.
- USDT and USDC are recognised by their official contracts only. Look-alike tokens (a common scam)
  are ignored.

**Data providers**

- Etherscan's free plan covers Ethereum and Polygon at about 5 requests per second and 100,000
  per day per key (Etherscan's limits, which can change). Without a key, Blockscout is used.
- Bitcoin falls back to Esplora servers when the Blockbook servers are down. Esplora lists at most
  50 unconfirmed transactions per address and does not support account keys.
- Litecoin has fewer free servers than Bitcoin (three Blockbook servers and one Esplora). If all of
  them are down or out of date, Litecoin syncing pauses and catches up when one returns; no data is
  lost.
- Solana's fastest public node keeps only about 2.5 days of history; older history comes from
  slower nodes. Token accounts that are not associated token accounts and were closed before the
  wallet was added are not found.
- Free services change, rate limit or disappear without notice. `/status` shows what is working.

**Discord**

- Long lists (many wallets, coins or transactions) are shortened or paged to fit Discord's
  message limits. CSV exports always contain everything.
- Up to 50 price alerts.

## Data sources and fair use

| Network | Live tracking and history |
| --- | --- |
| Bitcoin, Litecoin | Blockbook servers (Trezor, Guarda, Zelcore, Atomic Wallet, litecoinblockexplorer.net) with Esplora (Blockstream, mempool.space, litecoinspace) as fallback |
| Ethereum, Polygon | Public RPC nodes for change detection; Etherscan API (your key), Blockscout fallback |
| BNB Smart Chain, Base | Public RPC nodes; history rebuilt from historical balances on public archive nodes (Etherscan's free plan does not cover these chains) |
| Solana | Public RPC nodes (publicnode, Trezor, Ledger, Solana Foundation) |
| XRP Ledger | Public XRPL servers (Ripple, xrplcluster) |
| Prices | CoinGecko and Binance (live), Binance, Coinbase and CoinGecko (history) |

These are free public services run by others. Your use is subject to their terms. The bot keeps
request rates conservative, caches heavily and caps history imports. Some backends (Trezor,
Ledger, Guarda, Zelcore, Atomic Wallet) are operated by wallet vendors for their own apps; the bot
keeps traffic to them light and never multiplies it through proxies. Optional proxies are meant for reliability;
do not use them to exceed a provider's limits or terms.

## Running 24/7

Any small VPS works (1 vCPU and 1 GB RAM are plenty); the bot needs no open inbound ports.
Step-by-step guide for **Linux (Debian/Ubuntu)** with systemd and for **Windows Server** with PM2
or NSSM: [docs/DEPLOY.md](docs/DEPLOY.md).

- **Linux**: Node + systemd. A ready, hardened unit file is in
  [deploy/crypto-portfolio.service](deploy/crypto-portfolio.service).
- **Windows or macOS**: `npm install -g pm2`, `pm2 start ecosystem.config.cjs`, `pm2 save`.
- **Docker**: `mkdir -p data && sudo chown 1000:1000 data`, put `wallets.txt` in `data/`, then
  `docker compose up -d --build`.

When the bot was offline, it catches up on start and summarizes missed transactions in one
message instead of a flood.

## Maintenance

- **Backups**: stop the bot and copy the `data/` folder (or copy it while running; SQLite WAL
  mode keeps the copy consistent enough for a personal backup, but a stopped copy is safest).
  Keep `.env` and `wallets.txt` backed up too.
- **Updates**: `git pull`, `npm ci --omit=dev`, restart. Database migrations run automatically.
- **Data check**: `npm run check-data` (read-only, safe while running).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Commands do not appear | Wait a minute after the first start; the bot needs the `applications.commands` scope and you must be an administrator of the server. |
| Commands appear twice | You switched between server and global registration: `npm run deploy-commands -- --clear` with `DISCORD_GUILD_ID` empty, then restart. |
| No DMs | Allow direct messages from server members, or set a channel with `/settings notifications`. |
| "This is a private bot." | Your user ID is not in `OWNER_IDS`. |
| "Sync issue" on a wallet | A free provider is down or rate limiting; the bot fails over and retries. `/status` shows which. |
| History import retrying | Failed imports retry after 2, 10, 30 and 60 minutes; `/wallet reimport` starts one now. |

## Development

```bash
npm ci
npm run check            # typecheck + formatting + tests
npm test                 # offline unit and integration tests
npm run format           # Prettier
node scripts/e2e.ts      # whole pipeline against live APIs, temporary database
node scripts/smoke/utxo.ts   # live checks per engine: utxo, evm, solana, xrp, xpub, prices
```

Layout: `src/chains` (one engine per chain family), `src/tracker` (polling, history import,
notifications, pricing, jobs), `src/portfolio` (ledger, classification, reports), `src/discord`
(commands and embeds), `src/wallets` (wallets.txt), `src/db` (SQLite). See
[CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Acknowledgements

This bot exists because these projects and services offer free, public access. Thank you.

- **Prices**: market data provided by [CoinGecko](https://www.coingecko.com), plus
  [Binance](https://www.binance.com) market data and [Coinbase](https://www.coinbase.com)
  Exchange candles.
- **Bitcoin and Litecoin**: [Blockbook](https://github.com/trezor/blockbook) servers run by
  [Trezor](https://trezor.io), [Guarda](https://guarda.com), [Zelcore](https://zelcore.io),
  [Atomic Wallet](https://atomicwallet.io) and [litecoinblockexplorer.net](https://litecoinblockexplorer.net);
  [Esplora](https://github.com/Blockstream/esplora) servers run by
  [Blockstream](https://blockstream.info), [mempool.space](https://mempool.space) and
  [litecoinspace.org](https://litecoinspace.org).
- **Ethereum, BNB Chain, Polygon and Base**: powered by [Etherscan.io APIs](https://etherscan.io)
  and [Blockscout](https://www.blockscout.com); public RPC nodes by
  [PublicNode](https://www.publicnode.com), [dRPC](https://drpc.org),
  [Blast API](https://blastapi.io), [Tatum](https://tatum.io), [Nodies](https://www.nodies.app),
  [1RPC](https://www.1rpc.io), [MeowRPC](https://meowrpc.com),
  [MEV Blocker](https://mevblocker.io) and [Base](https://base.org).
- **Solana**: RPC nodes by PublicNode, Trezor, [Ledger](https://www.ledger.com) and the
  [Solana Foundation](https://solana.org).
- **XRP Ledger**: public servers by [Ripple](https://xrpl.org) and
  [xrplcluster.com](https://xrplcluster.com).
- **Explorer links** in messages: mempool.space, Blockchair, Etherscan, BscScan, PolygonScan,
  BaseScan, Solscan and XRPScan.
- **Libraries**: [discord.js](https://discord.js.org), [undici](https://undici.nodejs.org),
  [Zod](https://zod.dev) and [Node.js](https://nodejs.org) with its built-in SQLite.
- Embed width bars are images from [dummyimage.com](https://dummyimage.com).

None of these services endorse or are affiliated with this project.

Developed with AI assistance. Every change is covered by automated tests and checked against real
on-chain balances (`npm run check-data`).

## License

Copyright (C) 2026 Ubaidullah71

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for details.
