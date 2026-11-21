# Contributing

Thanks for helping. Bug reports, fixes and new chains are welcome.

## Getting started

```bash
npm ci
cp .env.example .env     # only needed to run the bot
npm run check            # typecheck + formatting + tests (must pass before a pull request)
```

Node.js 22.18+ runs the TypeScript directly; there is no build step. Use `.ts` extensions in
imports and erasable syntax only (no enums, namespaces or constructor parameter properties).

## Guidelines

- **Privacy first.** Never commit real wallet addresses you own, API keys, tokens or databases.
  Test fixtures must use public, unrelated addresses (well-known test vectors or exchange wallets).
- **Read-only.** The bot must never handle private keys or sign anything.
- **Be gentle with free APIs.** Keep request rates conservative, cache results, and route every
  request through `src/util/http.ts` (rate limits, retries, failover). New wallet-vendor backends
  must be added to `VENDOR_HOSTS`.
- **Treat remote data as untrusted.** Validate shapes and addresses, parse amounts with BigInt,
  and escape anything shown in Discord (`safe()`, `table()`).
- **Accounting changes need tests.** `test/ledger.test.ts` and `test/pipeline.test.ts` show the
  style. Run `npm run check-data` against your own database to confirm balances still reconcile.
- **Chain adapters** implement `ChainAdapter` in `src/core/types.ts`. Read its comments: amounts
  exclude the fee, `chargeFee` is set exactly once per transaction, one row per (transaction, coin).
  Add offline tests with real (public) fixtures and a live smoke script under `scripts/smoke/`.
- Format with `npm run format`. Commit messages follow Conventional Commits
  (`fix(evm): ...`, `feat: ...`).

## Pull requests

Describe what changed and why, how you tested it (unit tests, smoke script, real usage), and any
effect on stored data. Keep pull requests focused.

By contributing you agree that your contributions are licensed under GPL-3.0-or-later.
