import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawTransfer } from '../../src/core/types.ts';
import { createSolanaAdapter, readCursor, type SolanaCursor } from '../../src/chains/solana/adapter.ts';
import { base58Encode, decodePublicKey, deriveAssociatedTokenAddress, isOnCurve } from '../../src/chains/solana/keys.ts';
import { SolanaParseError, parseSolanaTransaction } from '../../src/chains/solana/parse.ts';
import { SolanaRpc, type CallOptions } from '../../src/chains/solana/rpc.ts';
import type { RpcCall } from '../../src/util/http.ts';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(here, '..', 'fixtures', 'solana', `${name}.json`), 'utf8'));
}

const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const parse = (tx: unknown, owner: string, finalized = true) => parseSolanaTransaction(tx, owner, { finalized });
const bySub = (rows: RawTransfer[]) => Object.fromEntries(rows.map((r) => [r.subId, r]));

describe('solana keys', () => {
  it('base58 round-trips and derives associated token accounts', () => {
    const k = 'b619EzHShebQRX7oouwUD5fUo72ai8GgcMLAHkcqfG2';
    expect(base58Encode(decodePublicKey(k)!)).toBe(k);
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    // Real ATA created in fixture usdt-receive-creates-ata.
    expect(deriveAssociatedTokenAddress('3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ', USDT)).toBe(
      'DCsjigVdgp7AcYLzUrHVZT6ForKxy5mqveGVqyKFQP6Q',
    );
    expect(isOnCurve(decodePublicKey(k)!)).toBe(true); // wallet key
    expect(isOnCurve(decodePublicKey('DCsjigVdgp7AcYLzUrHVZT6ForKxy5mqveGVqyKFQP6Q')!)).toBe(false); // PDA
    expect(decodePublicKey('not-an-address')).toBeNull();
  });
});

describe('parseSolanaTransaction', () => {
  it('SOL receive and send (v0 transaction, sender pays the fee)', () => {
    const tx = fixture('sol-transfer-v0');
    const recv = parse(tx, '6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG');
    expect(recv).toHaveLength(1);
    expect(recv[0]).toMatchObject({
      txid: '36FK3v19bbQgnHiSemNE7JKnCAqJc8HFZkeiYs7qa9sJbe2t3cdHTcrzjU7WJsKu4hx5c9m7K3rSi4VSx956hjaU',
      subId: 'native',
      assetKey: 'solana:native',
      direction: 'in',
      amount: 530000000n,
      fee: 5100n,
      chargeFee: false,
      counterparty: 'Dch5j8vcCJSEWHqsqQbTbxL4MWhBVrWFxiuVCBn7EUdN',
      blockHeight: 471680318,
      blockTime: 1795165462,
      status: 'confirmed',
    });
    const send = parse(tx, 'Dch5j8vcCJSEWHqsqQbTbxL4MWhBVrWFxiuVCBn7EUdN');
    expect(send).toHaveLength(1);
    expect(send[0]).toMatchObject({ direction: 'out', amount: 530000000n, fee: 5100n, chargeFee: true });
    expect(send[0]!.counterparty).toBe('6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG');
    expect(send[0]!.counterparties).toEqual(['6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG']);
    // Uninvolved account (the system program) gets nothing.
    expect(parse(tx, '11111111111111111111111111111111')).toEqual([]);
  });

  it('SOL transfer in a version 1 transaction; pending until finalized', () => {
    const tx = fixture('sol-transfer-v1');
    expect(tx.version).toBe(1);
    const recv = parse(tx, '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', false);
    expect(recv).toEqual([
      expect.objectContaining({ direction: 'in', amount: 100001n, chargeFee: false, status: 'pending', blockHeight: tx.slot }),
    ]);
    const send = parse(tx, 'Asn7SUy1s7xEroHqfJPBqjd8VqdjCujpgty6TFyKiYEg');
    expect(send).toEqual([
      expect.objectContaining({ direction: 'out', amount: 100001n, fee: 5000n, chargeFee: true, status: 'confirmed' }),
    ]);
  });

  it('USDT receive into an existing ATA; sender gets a token row plus a fee-only SOL row', () => {
    const tx = fixture('usdt-transfer-existing-ata');
    const recv = parse(tx, '89MJwY8Ubadzr5jXqZUuESvideVJc2ZGsd4J2aASgWp5');
    expect(recv).toEqual([
      expect.objectContaining({
        subId: `token:${USDT}`,
        assetKey: `solana:${USDT}`,
        direction: 'in',
        amount: 500000000n,
        chargeFee: false,
        counterparty: 'HWpNw53LwxME4zuYpmeMptmGaBmQBaL6hCrDfG2coMZi',
      }),
    ]);
    const send = bySub(parse(tx, 'HWpNw53LwxME4zuYpmeMptmGaBmQBaL6hCrDfG2coMZi'));
    expect(Object.keys(send).sort()).toEqual(['native', `token:${USDT}`]);
    expect(send.native).toMatchObject({ amount: 0n, direction: 'out', chargeFee: true, fee: 5780n, meta: { feeOnly: true } });
    expect(send[`token:${USDT}`]).toMatchObject({
      direction: 'out',
      amount: 500000000n,
      chargeFee: false,
      counterparty: '89MJwY8Ubadzr5jXqZUuESvideVJc2ZGsd4J2aASgWp5',
    });
  });

  it('USDC transfer where a third party (relayer) pays the fee', () => {
    const tx = fixture('usdc-transfer-relayer-fee');
    expect(parse(tx, 'AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA')).toEqual([
      expect.objectContaining({
        subId: `token:${USDC}`,
        direction: 'in',
        amount: 1000n,
        counterparty: '22CdX2YyLMNb3XJ4cV2VtxbJ7ivQbf59HSpXEyfCSeBb',
      }),
    ]);
    // The token owner signs but does not pay the fee: no SOL row, no fee charge.
    expect(parse(tx, '22CdX2YyLMNb3XJ4cV2VtxbJ7ivQbf59HSpXEyfCSeBb')).toEqual([
      expect.objectContaining({ subId: `token:${USDC}`, direction: 'out', amount: 1000n, chargeFee: false }),
    ]);
    expect(parse(tx, '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4')).toEqual([
      expect.objectContaining({ subId: 'native', amount: 0n, chargeFee: true, fee: 10001n, meta: { feeOnly: true } }),
    ]);
  });

  it('sums several token accounts of the same owner and mint', () => {
    const tx = fixture('usdc-receive-two-accounts');
    expect(parse(tx, '36Q2NicqLeS2a6vPc3G2g9nS7inrTQQL8azsY3suQwJ8')).toEqual([
      expect.objectContaining({
        subId: `token:${USDC}`,
        direction: 'in',
        amount: 1n,
        counterparty: 'GdegE4nrvYZFqdm63wWTQaZwVsfuDkEUPgtMKYdnVpFw',
      }),
    ]);
  });

  it('token receive that creates the ATA in the same transaction (missing pre balance = 0)', () => {
    const tx = fixture('usdt-receive-creates-ata');
    expect(parse(tx, '3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ')).toEqual([
      expect.objectContaining({
        subId: `token:${USDT}`,
        direction: 'in',
        amount: 181894362n,
        counterparty: '7DoU2Z1sBF1KuAV3Qbc7KAkerTrbfA7wfW36DN43W2Mh',
      }),
    ]);
    // Fee payer funded the new account's rent: a real SOL outflow, fee excluded from amount.
    expect(parse(tx, '3DBAzxP6oBGbo5WD9jyqcGZPH4y6AmZKPET5y3Qc96hF')).toEqual([
      expect.objectContaining({
        subId: 'native',
        direction: 'out',
        amount: 1488440n,
        fee: 60000n,
        chargeFee: true,
        counterparty: 'DCsjigVdgp7AcYLzUrHVZT6ForKxy5mqveGVqyKFQP6Q',
      }),
    ]);
    expect(parse(tx, '7DoU2Z1sBF1KuAV3Qbc7KAkerTrbfA7wfW36DN43W2Mh')).toEqual([
      expect.objectContaining({
        subId: `token:${USDT}`,
        direction: 'out',
        amount: 181894362n,
        counterparty: '3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ',
      }),
    ]);
  });

  it('failed transaction: fee-only row for the payer, nothing for others', () => {
    const tx = fixture('failed-v1');
    expect(tx.meta.err).not.toBeNull();
    expect(parse(tx, 'BP8TxUroBDw97JWmc9bfg9bs8PoE6MA71SSihhBNUJR4')).toEqual([
      expect.objectContaining({
        subId: 'native',
        amount: 0n,
        direction: 'out',
        fee: 5087n,
        chargeFee: true,
        status: 'failed',
        meta: { feeOnly: true },
      }),
    ]);
    const other = tx.transaction.message.accountKeys[1].pubkey as string;
    expect(parse(tx, other)).toEqual([]);
  });

  it('v0 swap with address lookup tables (jsonParsed includes loaded keys)', () => {
    const tx = fixture('swap-v0-lookup-table');
    expect(tx.transaction.message.addressTableLookups.length).toBeGreaterThan(0);
    expect(tx.transaction.message.accountKeys[14]).toMatchObject({
      pubkey: '9Rt6GD1WN63Kw6Z6DbKvLwxkBgNMy1QwajBFYWJTfLCn',
      source: 'lookupTable',
    });
    const trader = bySub(parse(tx, 'b619EzHShebQRX7oouwUD5fUo72ai8GgcMLAHkcqfG2'));
    // Wrapped SOL is an untracked mint: no row. SOL account only paid the fee.
    expect(Object.keys(trader).sort()).toEqual(['native', `token:${USDC}`]);
    expect(trader.native).toMatchObject({ amount: 0n, chargeFee: true, fee: 5000n });
    expect(trader[`token:${USDC}`]).toMatchObject({
      direction: 'out',
      amount: 465871514n,
      counterparty: '8R5qdXKMn2KcfHBy9rEpi43KScHewqvRAcpFyqoL3wap',
    });
    // Account loaded from a lookup table (index 14): balance indexes must line up.
    expect(parse(tx, '9Rt6GD1WN63Kw6Z6DbKvLwxkBgNMy1QwajBFYWJTfLCn')).toEqual([
      expect.objectContaining({
        subId: 'native',
        direction: 'in',
        amount: 6441658337n,
        counterparty: '6ZPorXXoNedd3u2unPzZRg18LDrE4CQZcUarumuhZdbD',
      }),
    ]);
    expect(parse(tx, '8R5qdXKMn2KcfHBy9rEpi43KScHewqvRAcpFyqoL3wap')).toEqual([
      expect.objectContaining({
        subId: `token:${USDC}`,
        direction: 'in',
        amount: 465871514n,
        counterparty: 'b619EzHShebQRX7oouwUD5fUo72ai8GgcMLAHkcqfG2',
      }),
    ]);
  });

  it('"json" encoding (static keys + meta.loadedAddresses) gives identical results', () => {
    const parsed = fixture('swap-v0-lookup-table');
    const raw = fixture('swap-v0-lookup-table.json-encoding');
    expect(raw.transaction.message.accountKeys).toHaveLength(14);
    for (const who of [
      'b619EzHShebQRX7oouwUD5fUo72ai8GgcMLAHkcqfG2',
      '9Rt6GD1WN63Kw6Z6DbKvLwxkBgNMy1QwajBFYWJTfLCn',
      '8R5qdXKMn2KcfHBy9rEpi43KScHewqvRAcpFyqoL3wap',
    ]) {
      expect(parse(raw, who)).toEqual(parse(parsed, who));
    }
  });

  it('charges the fee on exactly one row, only for the fee payer', () => {
    for (const name of [
      'sol-transfer-v0',
      'sol-transfer-v1',
      'usdt-transfer-existing-ata',
      'usdc-transfer-relayer-fee',
      'usdc-receive-two-accounts',
      'usdt-receive-creates-ata',
      'failed-v1',
      'swap-v0-lookup-table',
    ]) {
      const tx = fixture(name);
      const keys = (tx.transaction.message.accountKeys as Array<{ pubkey: string }>).map((k) => k.pubkey);
      const owners = new Set<string>(keys);
      for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) owners.add(b.owner);
      for (const who of owners) {
        const rows = parse(tx, who);
        const charged = rows.filter((r) => r.chargeFee).length;
        expect(charged, `${name} ${who}`).toBe(who === keys[0] ? 1 : 0);
        expect(new Set(rows.map((r) => r.subId)).size).toBe(rows.length);
        for (const r of rows)
          expect(r.assetKey === 'solana:native' || r.assetKey === `solana:${USDT}` || r.assetKey === `solana:${USDC}`).toBe(true);
      }
    }
  });

  it('only emits well-formed public keys as counterparties', () => {
    const bad = 'Dch5j8vcCJSEWHqsqQbTbxL4MWhBVrWFxiuVCBn7EUd0'; // 44 chars, "0" is not base58
    // Static account key of the sender.
    const sol = fixture('sol-transfer-v0');
    sol.transaction.message.accountKeys[0].pubkey = bad;
    const recv = parse(sol, '6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG');
    expect(recv).toEqual([expect.objectContaining({ direction: 'in', amount: 530000000n, counterparty: null, counterparties: [] })]);

    // Token-balance owner: falls back to the (valid) token account, never the bogus string.
    const tok = fixture('usdt-transfer-existing-ata');
    for (const b of [...tok.meta.preTokenBalances, ...tok.meta.postTokenBalances]) if (b.accountIndex === 1) b.owner = '<@everyone>';
    const r1 = parse(tok, '89MJwY8Ubadzr5jXqZUuESvideVJc2ZGsd4J2aASgWp5');
    expect(r1[0]!.counterparty).toBe(tok.transaction.message.accountKeys[1].pubkey);
    // ...and to null when the account key is bogus too.
    tok.transaction.message.accountKeys[1].pubkey = 'x'.repeat(44);
    const r2 = parse(tok, '89MJwY8Ubadzr5jXqZUuESvideVJc2ZGsd4J2aASgWp5');
    expect(r2[0]).toMatchObject({ amount: 500000000n, counterparty: null, counterparties: [] });

    // Address loaded from a lookup table ("json" encoding).
    const raw = fixture('swap-v0-lookup-table.json-encoding');
    raw.meta.loadedAddresses.writable[0] = bad;
    const out = parse(raw, '6ZPorXXoNedd3u2unPzZRg18LDrE4CQZcUarumuhZdbD');
    expect(out).toEqual([expect.objectContaining({ direction: 'out', amount: 6441658337n, counterparty: null })]);
    expect(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(bad);
    raw.meta.loadedAddresses.readonly[0] = 'short';
    expect(() => parse(raw, '6ZPorXXoNedd3u2unPzZRg18LDrE4CQZcUarumuhZdbD')).toThrow(SolanaParseError);
  });

  it('rejects malformed data with SolanaParseError', () => {
    const good = fixture('sol-transfer-v0');
    const owner = '6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG';
    expect(() => parse(null, owner)).toThrow(SolanaParseError);
    expect(() => parse({ ...good, meta: null }, owner)).toThrow(SolanaParseError);
    expect(() => parse({ ...good, meta: { ...good.meta, postBalances: [1, 2] } }, owner)).toThrow(SolanaParseError);
    expect(() => parse({ ...good, meta: { ...good.meta, fee: '5000' } }, owner)).toThrow(SolanaParseError);
    const tok = fixture('usdt-transfer-existing-ata');
    tok.meta.postTokenBalances[0].uiTokenAmount.amount = '12abc';
    expect(() => parse(tok, '89MJwY8Ubadzr5jXqZUuESvideVJc2ZGsd4J2aASgWp5')).toThrow(SolanaParseError);
    expect(() => parseSolanaTransaction(good, owner, { finalized: true, signature: 'x'.repeat(88) })).toThrow(SolanaParseError);
  });
});

describe('cursor', () => {
  it('validates and normalizes', () => {
    expect(() => readCursor({})).toThrow();
    expect(() => readCursor({ v: 2, heads: {} })).toThrow();
    const c = readCursor({
      v: 1,
      initSlot: 10,
      heads: { '6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG': { sig: null, slot: 10, at: 5 }, bad: { sig: null, slot: 1 } },
      tokenAccounts: { DCsjigVdgp7AcYLzUrHVZT6ForKxy5mqveGVqyKFQP6Q: USDT, '11111111111111111111111111111111': 'SpamMint' },
      pending: [{ sig: 'nope' }],
      polls: 3,
    });
    expect(Object.keys(c.heads)).toEqual(['6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG']);
    expect(c.tokenAccounts).toEqual({ DCsjigVdgp7AcYLzUrHVZT6ForKxy5mqveGVqyKFQP6Q: USDT });
    expect(c.pending).toEqual([]);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });
});

// --- Adapter logic against an in-memory chain ---

interface FakeSig {
  account: string;
  signature: string;
  slot: number;
  status: 'confirmed' | 'finalized';
  tx: unknown;
}

const LIMITED = 'https://limited.invalid';
const FULL = 'https://full.invalid';

class FakeRpc extends SolanaRpc {
  sigs: FakeSig[] = [];
  /** Signatures older than this slot are invisible on the limited endpoint. */
  limitedFromSlot = 0;
  /** Signatures the limited endpoint fails to index (inconsistent backend). */
  hiddenOnLimited = new Set<string>();
  /** getTransaction fails (network-style error) for these signatures. */
  failTx = new Set<string>();
  /** getTransaction returns null for these signatures although they have a status. */
  txMissing = new Set<string>();
  /** Simulates an endpoint that ignores the `before` parameter. */
  ignoreBefore = false;
  calls: Array<{ url: string; method: string }> = [];

  constructor() {
    super({
      live: [
        { url: LIMITED, fullHistory: false },
        { url: FULL, fullHistory: true },
      ],
      history: [{ url: FULL, fullHistory: true }],
    });
  }

  override async callAt<T>(url: string, method: string, params: unknown, _o?: CallOptions): Promise<T> {
    this.calls.push({ url, method });
    const p = params as any[];
    const visible = (s: FakeSig) => url === FULL || (s.slot >= this.limitedFromSlot && !this.hiddenOnLimited.has(s.signature));
    switch (method) {
      case 'getSlot':
        return 1000 as T;
      case 'minimumLedgerSlot':
        return this.limitedFromSlot as T;
      case 'getBlockTime':
        return 1_700_000_000 as T;
      case 'getBalance':
        return { context: { slot: 1000 }, value: 42 } as T;
      case 'getTokenAccountsByOwner':
        return { context: { slot: 1000 }, value: [] } as T;
      case 'getSignaturesForAddress': {
        const [account, { limit, before }] = p as [string, { limit: number; before?: string }];
        let list = this.sigs.filter((s) => s.account === account && visible(s)).sort((a, b) => b.slot - a.slot);
        if (before && !this.ignoreBefore) {
          const i = list.findIndex((s) => s.signature === before);
          list = i >= 0 ? list.slice(i + 1) : [];
        }
        return list
          .slice(0, limit)
          .map((s) => ({ signature: s.signature, slot: s.slot, err: null, blockTime: null, confirmationStatus: s.status })) as T;
      }
      case 'getTransaction': {
        if (this.failTx.has(p[0])) throw new Error('connection reset');
        if (this.txMissing.has(p[0])) return null as T;
        const s = this.sigs.find((x) => x.signature === p[0] && visible(x));
        return (s ? s.tx : null) as T;
      }
      case 'getSignatureStatuses': {
        const value = (p[0] as string[]).map((sig) => {
          const s = this.sigs.find((x) => x.signature === sig);
          return s ? { slot: s.slot, err: null, confirmationStatus: s.status, confirmations: null } : null;
        });
        return { context: { slot: 1000 }, value } as T;
      }
    }
    throw new Error(`unexpected method ${method}`);
  }

  override async batchAt(url: string, calls: readonly RpcCall[], o?: CallOptions): Promise<unknown[]> {
    return Promise.all(calls.map((c) => this.callAt(url, c.method, c.params, o)));
  }
}

describe('solana adapter (offline)', () => {
  const v0 = fixture('sol-transfer-v0');
  const receiver = '6UyEZFZrWg1bVXk1XUKZoniUUJre6neV1ayziz3pupqG';
  const sig = v0.transaction.signatures[0] as string;

  it('poll reports a pending transfer, then the confirmed version once finalized', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const cursor = await adapter.initCursor(receiver);
    expect((cursor as SolanaCursor).heads[receiver]).toMatchObject({ sig: null });

    rpc.sigs.push({ account: receiver, signature: sig, slot: v0.slot, status: 'confirmed', tx: v0 });
    const r1 = await adapter.poll(receiver, cursor);
    expect(r1.transfers).toEqual([expect.objectContaining({ txid: sig, direction: 'in', amount: 530000000n, status: 'pending' })]);
    expect((r1.cursor as SolanaCursor).pending.map((p) => p.sig)).toEqual([sig]);
    expect((r1.cursor as SolanaCursor).heads[receiver]!.sig).toBe(sig);

    const r2 = await adapter.poll(receiver, JSON.parse(JSON.stringify(r1.cursor)));
    expect(r2.transfers).toEqual([]); // still not final, already emitted

    rpc.sigs[0]!.status = 'finalized';
    const r3 = await adapter.poll(receiver, r2.cursor);
    expect(r3.transfers).toEqual([expect.objectContaining({ txid: sig, status: 'confirmed' })]);
    expect((r3.cursor as SolanaCursor).pending).toEqual([]);

    const r4 = await adapter.poll(receiver, r3.cursor);
    expect(r4.transfers).toEqual([]);
  });

  it('keeps pending entries across downtime and drops only ones with no status anywhere', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const cursor = await adapter.initCursor(receiver);
    rpc.sigs.push({ account: receiver, signature: sig, slot: v0.slot, status: 'confirmed', tx: v0 });
    const r1 = await adapter.poll(receiver, cursor);
    const c1 = r1.cursor as SolanaCursor;
    // The bot was down for 3 hours; meanwhile the transaction finalized.
    c1.pending[0]!.at -= 3 * 3600_000;
    // Reported earlier, and no endpoint has known it for 20 minutes: dropped (its rows exist).
    c1.pending.push({ sig: '1'.repeat(64), at: Date.now() - 3 * 3600_000, emitted: true, missingSince: Date.now() - 20 * 60_000 });
    rpc.sigs[0]!.status = 'finalized';
    const r2 = await adapter.poll(receiver, c1);
    expect(r2.transfers).toEqual([expect.objectContaining({ txid: sig, status: 'confirmed' })]);
    expect((r2.cursor as SolanaCursor).pending).toEqual([]);
  });

  it('trusts the limited endpoint for a dormant account whose head is older than its window', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    rpc.sigs.push({ account: receiver, signature: '1'.repeat(64), slot: 100, status: 'finalized', tx: v0 });
    const cursor = await adapter.initCursor(receiver);
    expect((cursor as SolanaCursor).heads[receiver]).toMatchObject({ sig: '1'.repeat(64), slot: 100 });
    rpc.limitedFromSlot = 500; // limited node pruned everything before slot 500
    rpc.calls = [];
    const quiet = await adapter.poll(receiver, cursor);
    expect(quiet.transfers).toEqual([]);
    expect(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress').every((c) => c.url === LIMITED)).toBe(true);
    // New activity is inside the window, so the limited endpoint alone is enough.
    rpc.sigs.push({ account: receiver, signature: sig, slot: v0.slot, status: 'finalized', tx: v0 });
    rpc.calls = [];
    const r = await adapter.poll(receiver, quiet.cursor);
    expect(r.transfers).toEqual([expect.objectContaining({ txid: sig, status: 'confirmed' })]);
    expect(rpc.calls.some((c) => c.url === FULL && c.method === 'getSignaturesForAddress')).toBe(false);
    expect((r.cursor as SolanaCursor).heads[receiver]!.sig).toBe(sig);
  });

  it('re-scans on full history after downtime longer than the trust window', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    rpc.sigs.push({ account: receiver, signature: '1'.repeat(64), slot: 100, status: 'finalized', tx: v0 });
    const cursor = (await adapter.initCursor(receiver)) as SolanaCursor;
    for (const h of Object.values(cursor.heads)) h.at -= 7 * 3600_000;
    rpc.limitedFromSlot = 500;
    rpc.calls = [];
    await adapter.poll(receiver, cursor);
    expect(rpc.calls.some((c) => c.url === FULL && c.method === 'getSignaturesForAddress')).toBe(true);
  });

  it('treats a head missing inside the limited window as a gap and uses full history', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const head = { account: receiver, signature: '1'.repeat(64), slot: v0.slot - 50, status: 'finalized' as const, tx: v0 };
    rpc.sigs.push(head);
    const cursor = await adapter.initCursor(receiver);
    rpc.hiddenOnLimited.add(head.signature); // limited backend lost this signature
    rpc.sigs.push({ account: receiver, signature: sig, slot: v0.slot, status: 'finalized', tx: v0 });
    rpc.calls = [];
    const r = await adapter.poll(receiver, cursor);
    expect(r.transfers).toEqual([expect.objectContaining({ txid: sig })]);
    expect(rpc.calls.some((c) => c.url === FULL && c.method === 'getSignaturesForAddress')).toBe(true);
  });

  it('backfill returns everything up to and including the boundary, streaming batches', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const send = fixture('usdt-receive-creates-ata');
    const owner = '3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ';
    const ata = deriveAssociatedTokenAddress(owner, USDT);
    // The receive touched both the owner (ATA creation) and the ATA: listed twice, imported once.
    rpc.sigs.push({ account: owner, signature: send.transaction.signatures[0], slot: send.slot, status: 'finalized', tx: send });
    rpc.sigs.push({ account: ata, signature: send.transaction.signatures[0], slot: send.slot, status: 'finalized', tx: send });
    const boundary = await adapter.initCursor(owner);
    // Activity after the boundary belongs to live polling, not to the backfill.
    rpc.sigs.push({ account: ata, signature: sig, slot: send.slot + 10, status: 'finalized', tx: v0 });
    const batches: RawTransfer[][] = [];
    const stages = new Set<string>();
    const all = await adapter.backfill(owner, boundary, {
      onBatch: (b) => void batches.push(b),
      onProgress: (p) => void stages.add(p.stage),
    });
    expect(all).toEqual([expect.objectContaining({ subId: `token:${USDT}`, direction: 'in', amount: 181894362n })]);
    expect(batches.flat()).toEqual(all);
    expect([...stages]).toEqual(['Listing signatures', 'Fetching transactions']);
  });

  it('getBalances includes zero entries for every asset; getTxStatus maps commitment', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const b = await adapter.getBalances(receiver);
    expect(Object.fromEntries(b)).toEqual({ 'solana:native': 42n, [`solana:${USDT}`]: 0n, [`solana:${USDC}`]: 0n });
    rpc.sigs.push({ account: receiver, signature: sig, slot: v0.slot, status: 'confirmed', tx: v0 });
    expect(await adapter.getTxStatus(sig, receiver)).toEqual({ state: 'pending', blockHeight: v0.slot });
    rpc.sigs[0]!.status = 'finalized';
    expect(await adapter.getTxStatus(sig, receiver)).toEqual({ state: 'confirmed', blockHeight: v0.slot, blockTime: 1_700_000_000 });
    expect(await adapter.getTxStatus('2'.repeat(64), receiver)).toEqual({ state: 'unknown' });
    expect(await adapter.getTxStatus('garbage', receiver)).toEqual({ state: 'unknown' });
  });

  // --- bounded catch-up ---

  /** Valid-looking, unique 64-byte signature. */
  const sigFor = (i: number) => {
    const b = new Uint8Array(64).fill(9);
    b[61] = (i >> 16) & 255;
    b[62] = (i >> 8) & 255;
    b[63] = i & 255;
    return base58Encode(b);
  };
  /** n SOL receipts for `receiver`, oldest first (ascending slots). */
  const backlog = (n: number, from = 0): FakeSig[] =>
    Array.from({ length: n }, (_, k) => {
      const signature = sigFor(from + k);
      const slot = v0.slot + from + k;
      return {
        account: receiver,
        signature,
        slot,
        status: 'finalized',
        tx: { ...v0, slot, transaction: { ...v0.transaction, signatures: [signature] } },
      };
    });
  /** Polls until nothing new arrives; returns txids per poll. */
  async function drain(adapter: ReturnType<typeof createSolanaAdapter>, start: unknown, maxPolls = 40) {
    let cursor = start as SolanaCursor;
    const perPoll: string[][] = [];
    for (let k = 0; k < maxPolls; k++) {
      const r = await adapter.poll(receiver, cursor);
      cursor = r.cursor as SolanaCursor;
      perPoll.push(r.transfers.map((t) => t.txid));
      if (!r.transfers.length && !cursor.heads[receiver]!.frontiers) break; // caught up
    }
    return { perPoll, cursor };
  }

  it('processes a large catch-up oldest first, a bounded number per poll, advancing heads only over processed ones', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc, limits: { maxTxPerPoll: 50 } });
    const cursor = await adapter.initCursor(receiver);
    const txs = backlog(120);
    rpc.sigs.push(...txs);
    const r1 = await adapter.poll(receiver, cursor);
    expect(r1.transfers.map((t) => t.txid)).toEqual(txs.slice(0, 50).map((t) => t.signature));
    expect((r1.cursor as SolanaCursor).heads[receiver]!.sig).toBe(txs[49]!.signature);
    const { perPoll } = await drain(adapter, r1.cursor, 5);
    expect(perPoll.map((p) => p.length).slice(0, 3)).toEqual([50, 20, 0]);
    expect([...r1.transfers.map((t) => t.txid), ...perPoll.flat()]).toEqual(txs.map((t) => t.signature));
  });

  it('lists backlogs bigger than one poll can list across polls (frontier stack), each tx exactly once', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc, limits: { maxScanPages: 2, maxTxPerPoll: 1000 } });
    const cursor = await adapter.initCursor(receiver);
    const txs = backlog(2500);
    rpc.sigs.push(...txs);
    const r1 = await adapter.poll(receiver, cursor);
    expect(r1.transfers).toEqual([]); // only listing progress in this poll
    expect((r1.cursor as SolanaCursor).heads[receiver]!.frontiers).toHaveLength(1);
    const { perPoll, cursor: end } = await drain(adapter, r1.cursor, 20);
    expect(perPoll.flat()).toEqual(txs.map((t) => t.signature)); // oldest first, no duplicates, nothing lost
    expect(end.heads[receiver]).toMatchObject({ sig: txs[2499]!.signature });
    expect(end.heads[receiver]!.frontiers).toBeUndefined();
  });

  it('stops starting work when the time budget is used up, but always makes progress', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc, limits: { pollBudgetMs: 0 } });
    const cursor = await adapter.initCursor(receiver);
    const txs = backlog(30);
    rpc.sigs.push(...txs);
    const { perPoll } = await drain(adapter, cursor, 30);
    expect(Math.max(...perPoll.map((p) => p.length))).toBeLessThanOrEqual(4);
    expect(perPoll.flat()).toEqual(txs.map((t) => t.signature));
  });

  it('keeps the head below a transaction that failed to fetch and retries it next poll', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const cursor = await adapter.initCursor(receiver);
    const txs = backlog(10);
    rpc.sigs.push(...txs);
    rpc.failTx.add(txs[3]!.signature);
    const r1 = await adapter.poll(receiver, cursor);
    expect(r1.transfers.map((t) => t.txid)).toEqual(txs.slice(0, 3).map((t) => t.signature));
    expect((r1.cursor as SolanaCursor).heads[receiver]!.sig).toBe(txs[2]!.signature);
    expect((r1.cursor as SolanaCursor).pending).toEqual([]);
    rpc.failTx.clear();
    const r2 = await adapter.poll(receiver, r1.cursor);
    expect(r2.transfers.map((t) => t.txid)).toEqual(txs.slice(3).map((t) => t.signature));
  });

  // --- pending entries ---

  it('never drops pending entries that were never reported', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const c = (await adapter.initCursor(receiver)) as SolanaCursor;
    const now = Date.now();
    const [a, b, cc, d, e] = [1, 2, 3, 4, 5].map((i) => sigFor(5000 + i)) as [string, string, string, string, string];
    // c and d have a (final) status but the transaction itself cannot be fetched.
    for (const s of [cc, d]) rpc.sigs.push({ account: 'elsewhere', signature: s, slot: v0.slot, status: 'finalized', tx: v0 });
    rpc.txMissing.add(cc).add(d);
    c.pending = [
      { sig: a, at: now - 3 * 3600_000, emitted: false }, // no status anywhere, timer starts now
      { sig: b, at: now - 3 * 3600_000, emitted: false, missingSince: now - 20 * 60_000 }, // missing for 20 min
      { sig: cc, at: now - 48 * 3600_000, emitted: false }, // unfetchable for 2 days
      { sig: d, at: now - 48 * 3600_000, emitted: true }, // reported: may be dropped
      { sig: e, at: now - 3 * 3600_000, emitted: true, missingSince: now - 20 * 60_000 }, // reported: may be dropped
    ];
    const r = await adapter.poll(receiver, c);
    const p = (r.cursor as SolanaCursor).pending;
    expect(p.map((x) => x.sig)).toEqual([a, b, cc]);
    expect(p[0]!.missingSince).toBeGreaterThanOrEqual(now);
    expect(p[0]!.alerted).toBeUndefined();
    expect(p[1]).toMatchObject({ missingSince: now - 20 * 60_000, alerted: true });
    expect(p[2]).toMatchObject({ alerted: true });
    expect(p[2]!.missingSince).toBeUndefined();
  });

  it('honours the pending cap by dropping reported entries only', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    const c = (await adapter.initCursor(receiver)) as SolanaCursor;
    const now = Date.now();
    const unreported = Array.from({ length: 205 }, (_, i) => ({ sig: sigFor(6000 + i), at: now, emitted: false }));
    const reported = Array.from({ length: 10 }, (_, i) => ({ sig: sigFor(7000 + i), at: now, emitted: true }));
    for (const r of reported) rpc.sigs.push({ account: 'elsewhere', signature: r.sig, slot: v0.slot, status: 'confirmed', tx: v0 });
    c.pending = [...reported, ...unreported];
    const r = await adapter.poll(receiver, c);
    const p = (r.cursor as SolanaCursor).pending;
    expect(p).toHaveLength(205);
    expect(p.every((x) => !x.emitted)).toBe(true);
  });

  // --- backfill paging ---

  it('backfill fails clearly instead of looping when an endpoint ignores "before"', async () => {
    const rpc = new FakeRpc();
    const adapter = createSolanaAdapter({ rpc });
    rpc.sigs.push(...backlog(3));
    const boundary = await adapter.initCursor(receiver);
    rpc.ignoreBefore = true;
    await expect(adapter.backfill(receiver, boundary)).rejects.toThrow(/no paging progress/);
  });
});
