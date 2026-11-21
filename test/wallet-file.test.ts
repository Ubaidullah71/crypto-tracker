import { beforeEach, describe, expect, it, vi } from 'vitest';

const added: Array<{ walletId: number; network: string }> = [];
vi.mock('../src/tracker/tracker.ts', () => ({
  tracker: {
    addWalletNetwork: async (walletId: number, network: string) => {
      const { walletNetworks } = await import('../src/db/repo.ts');
      added.push({ walletId, network });
      return walletNetworks.create(walletId, network as never, { test: true });
    },
  },
}));

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfigForTests } from '../src/config.ts';
import { openDb } from '../src/db/database.ts';
import { walletNetworks, wallets } from '../src/db/repo.ts';
import { fileLabels, parseWalletFile, syncWalletFile, TEMPLATE } from '../src/wallets/file.ts';

const dir = mkdtempSync(join(tmpdir(), 'cp-wallets-'));
const file = join(dir, 'wallets.txt');

beforeEach(() => {
  setConfigForTests({ walletsFile: file });
  openDb(':memory:');
  added.length = 0;
});

describe('wallets.txt parser', () => {
  it('reads labels, plain addresses, network limits and inline comments', () => {
    const { entries, problems } = parseWalletFile(
      [
        '# comment',
        'Main LTC = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq   # cold storage',
        'Trading : 0x28C6c06298d514Db089934071355E5743bf21d60 @ bsc, base',
        'Wallet #2 | 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM (phantom)',
        '[Litecoin]',
        'Old = 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
      ].join('\r\n'),
    );
    expect(problems).toEqual([]);
    expect(entries.map((e) => [e.label, e.address])).toEqual([
      ['Main LTC', 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9'],
      [null, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
      ['Trading', '0x28C6c06298d514Db089934071355E5743bf21d60'],
      ['Wallet #2', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
      ['Old', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
    ]);
    expect(entries[2]!.hint).toEqual(['bsc', 'base']);
    expect(entries[4]!.section).toEqual(['litecoin']);
  });

  it('the untouched template produces no wallets and no warnings', () => {
    expect(parseWalletFile(TEMPLATE)).toEqual({ entries: [], problems: [] });
  });

  it('filling in one placeholder tracks exactly that wallet', () => {
    const filled = TEMPLATE.replace('PASTE-LTC-ADDRESS-HERE', 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9');
    const { entries, problems } = parseWalletFile(filled);
    expect(problems).toEqual([]);
    expect(entries.map((e) => [e.label, e.address])).toEqual([['LTC Main', 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9']]);
  });

  it('flags seed phrases without echoing them', () => {
    const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const { entries, problems } = parseWalletFile(`Oops = ${seed}`);
    expect(entries).toEqual([]);
    expect(problems[0]!.line).toBe(1);
    expect(problems[0]!.message).toMatch(/seed/);
    expect(JSON.stringify(problems)).not.toContain('abandon');
  });

  it('rejects unknown networks', () => {
    expect(parseWalletFile('x = 0x28C6c06298d514Db089934071355E5743bf21d60 @ tron').problems[0]!.message).toMatch(/Unknown network/);
  });
});

describe('wallets.txt sync', () => {
  it('adds new wallets, extends networks, renames, and reports problems', async () => {
    writeFileSync(
      file,
      [
        'Main LTC = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
        'EVM = 0x28C6c06298d514Db089934071355E5743bf21d60 @ bsc',
        'Ambiguous = 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
        'Key = 5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ',
        'Bad = notanaddress',
      ].join('\n'),
    );
    const r1 = await syncWalletFile();
    expect(r1.added.map((a) => [a.label, a.networks])).toEqual([
      ['Main LTC', ['litecoin']],
      ['EVM', ['bsc']],
    ]);
    expect(r1.problems.map((p) => p.line)).toEqual([3, 4, 5]);
    expect(r1.problems[1]!.message).toMatch(/private key/);
    expect(JSON.stringify(r1)).not.toContain('5HueCGU8');

    // Second run: same file -> nothing new.
    const r2 = await syncWalletFile();
    expect(r2.added).toEqual([]);
    expect(r2.unchanged).toBe(2);

    // Widen the EVM wallet to all networks and rename the LTC wallet.
    writeFileSync(
      file,
      ['Litecoin Main = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9', 'EVM = 0x28C6c06298d514Db089934071355E5743bf21d60'].join('\n'),
    );
    const r3 = await syncWalletFile();
    expect(r3.renamed).toEqual([{ from: 'Main LTC', to: 'Litecoin Main' }]);
    expect(r3.extended[0]!.networks.sort()).toEqual(['base', 'ethereum', 'polygon']);
    const evm = wallets.byLabel('EVM')!;
    expect(
      walletNetworks
        .forWallet(evm.id)
        .map((w) => w.network)
        .sort(),
    ).toEqual(['base', 'bsc', 'ethereum', 'polygon']);
    expect(wallets.list()).toHaveLength(2);

    // Removing lines never deletes wallets.
    writeFileSync(file, '# empty\n');
    const r4 = await syncWalletFile();
    expect(r4.notInFile.sort()).toEqual(['EVM', 'Litecoin Main']);
    expect(wallets.list()).toHaveLength(2);
  });

  it('supports several addresses per coin and never flip-flops on a duplicated address', async () => {
    writeFileSync(
      file,
      [
        'LTC Main = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
        'LTC Payments = ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt',
        'LTC Again = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
        'Phantom = 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        'Solflare = 3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ',
      ].join('\n'),
    );
    const r1 = await syncWalletFile();
    expect(r1.added.map((a) => a.label)).toEqual(['LTC Main', 'LTC Payments', 'Phantom', 'Solflare']);
    expect(r1.problems).toEqual([{ line: 3, message: 'Same address as line 1; only line 1 is used.' }]);
    const r2 = await syncWalletFile();
    expect(r2.renamed).toEqual([]);
    expect(wallets.byLabel('LTC Main')).toBeTruthy();
  });

  it('does not undo /wallet rename or /wallet networks unless the line changes', async () => {
    writeFileSync(file, 'EVM = 0x28C6c06298d514Db089934071355E5743bf21d60\n');
    await syncWalletFile();
    const w = wallets.byLabel('EVM')!;
    // User removes Polygon and renames the wallet with commands.
    const poly = walletNetworks.forWallet(w.id).find((wn) => wn.network === 'polygon')!;
    walletNetworks.remove(poly.id);
    wallets.rename(w.id, 'Main EVM');
    const r = await syncWalletFile();
    expect(r.extended).toEqual([]);
    expect(r.renamed).toEqual([]);
    expect(wallets.get(w.id)!.label).toBe('Main EVM');
    expect(walletNetworks.forWallet(w.id).map((x) => x.network)).not.toContain('polygon');
    // Editing the line in the file applies again.
    writeFileSync(file, 'Trading = 0x28C6c06298d514Db089934071355E5743bf21d60 @ polygon, bsc\n');
    const r2 = await syncWalletFile();
    expect(r2.renamed).toEqual([{ from: 'Main EVM', to: 'Trading' }]);
    expect(r2.extended[0]!.networks).toEqual(['polygon']);
  });

  it('re-reads the file when it is saved while a sync is running', async () => {
    writeFileSync(file, 'LTC Main = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9\n');
    const first = syncWalletFile();
    writeFileSync(file, 'LTC Main = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9\nPhantom = 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\n');
    const second = syncWalletFile();
    await first;
    const r = await second;
    expect(wallets.byLabel('Phantom')).toBeTruthy();
    expect(r.entries).toBe(2);
  });

  it('allows a comment after an address without a name', () => {
    const { entries, problems } = parseWalletFile(
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq # note: ledger\nWallet #2 = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
    );
    expect(problems).toEqual([]);
    expect(entries.map((e) => [e.label, e.address])).toEqual([
      [null, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
      ['Wallet #2', 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9'],
    ]);
  });

  it('generates unique labels for unlabeled addresses', async () => {
    writeFileSync(file, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq\nLNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9\n');
    const r = await syncWalletFile();
    expect(r.added.map((a) => a.label)).toEqual(['BTC bc1qa..5mdq', 'LTC LNWP2..Wyv9']);
  });
  it('one name on several lines (a wallet app with several coins) gets the chain added', async () => {
    writeFileSync(
      file,
      [
        'Exodus = bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        'Exodus = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
        'Exodus = 0x28C6c06298d514Db089934071355E5743bf21d60',
        'Exodus = 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        'Exodus = rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh',
        'Ledger = ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt',
      ].join('\n'),
    );
    const r1 = await syncWalletFile();
    expect(r1.problems).toEqual([]);
    expect(r1.added.map((a) => a.label)).toEqual(['Exodus BTC', 'Exodus LTC', 'Exodus EVM', 'Exodus SOL', 'Exodus XRP', 'Ledger']);

    // Renaming in the file renames the wallets; a second sync changes nothing.
    writeFileSync(
      file,
      [
        'Exodus = bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        'Exodus = LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9',
        'Main = 0x28C6c06298d514Db089934071355E5743bf21d60',
        'Main = 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        'Exodus XRP = rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh',
        'Ledger = ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt',
      ].join('\n'),
    );
    const r2 = await syncWalletFile();
    expect(r2.problems).toEqual([]);
    expect(r2.renamed).toEqual([
      { from: 'Exodus EVM', to: 'Main EVM' },
      { from: 'Exodus SOL', to: 'Main SOL' },
    ]);
    expect((await syncWalletFile()).renamed).toEqual([]);
  });

  it('chain-tagged names stay unique and within the length limit', () => {
    const evm = ['ethereum', 'bsc', 'polygon', 'base'] as const;
    expect(
      fileLabels([
        { label: 'Exodus', networks: ['bitcoin'] },
        { label: 'exodus', networks: ['bitcoin'] },
        { label: 'Exodus', networks: [...evm] },
        { label: 'Exodus', networks: ['bsc'] },
        { label: 'Exodus BTC 2', networks: ['litecoin'] },
        { label: 'Solo', networks: ['solana'] },
        { label: null, networks: ['xrp'] },
      ]),
    ).toEqual(['Exodus BTC', 'exodus BTC 3', 'Exodus EVM', 'Exodus BSC', 'Exodus BTC 2', 'Solo', null]);
    const long = 'A'.repeat(40);
    const out = fileLabels([
      { label: long, networks: ['polygon'] },
      { label: long, networks: ['polygon'] },
    ]);
    expect(out.every((l) => l!.length <= 40)).toBe(true);
    expect(new Set(out).size).toBe(2);
  });
});
