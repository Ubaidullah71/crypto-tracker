# Security Policy

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button
(Security tab of this repository) instead of opening a public issue. Include steps to reproduce
and the affected version or commit. You will get a reply as soon as possible.

Never include real tokens, API keys, private keys, wallet lists or database files in a report or
issue. Logs should be checked for addresses you do not want to share before posting them.

## Design notes

- The bot is read-only: it works with public addresses and extended public keys only and has no
  code path that signs or sends transactions. It refuses and never stores private keys or
  recovery phrases pasted by mistake.
- Only Discord users listed in `OWNER_IDS` can use any command, button, menu or form.
- Secrets (Discord token, Etherscan keys, proxy credentials) come from `.env` and are redacted
  from logs. The database, `.env` and `wallets.txt` should be readable only by the bot's user.
- All SQL is parameterized. Data from blockchain APIs is validated and escaped before it is
  shown in Discord or written to CSV exports.
- Dependencies are pinned to exact versions (`package-lock.json`).

## Scope

In scope: this repository's code and default configuration. 

Out of scope: the third-party blockchain and price services the bot reads from, and Discord itself.