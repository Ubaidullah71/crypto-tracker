import { describe, expect, it } from 'vitest';
import { detectAddress, isValidEvmAddress, looksLikeSecret, toChecksumAddress } from '../src/core/address.ts';
import { decimalToUnits, formatUnits, parseUnits } from '../src/core/amount.ts';
import { keccak256Hex } from '../src/core/keccak.ts';

describe('keccak256', () => {
  it('matches known vectors', () => {
    expect(keccak256Hex('')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(keccak256Hex('abc')).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    expect(keccak256Hex('Transfer(address,address,uint256)')).toBe('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    // Longer than one 136-byte block
    expect(keccak256Hex('a'.repeat(200))).toHaveLength(64);
  });
});

describe('EIP-55', () => {
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  it('checksums', () => {
    for (const v of vectors) {
      expect(toChecksumAddress(v.toLowerCase())).toBe(v);
      expect(isValidEvmAddress(v)).toBe(true);
    }
    expect(isValidEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false);
  });
});

describe('amounts', () => {
  it('formats and parses exactly', () => {
    expect(formatUnits(576036866n, 8)).toBe('5.76036866');
    expect(formatUnits(100000000n, 8)).toBe('1');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnits(-1500n, 3)).toBe('-1.5');
    expect(parseUnits('5.76036866', 8)).toBe(576036866n);
    expect(parseUnits('0.1', 18)).toBe(100000000000000000n);
    expect(decimalToUnits('0.00000986', 8)).toBe(986n);
    expect(decimalToUnits('1e-8', 8)).toBe(1n);
    expect(() => parseUnits('1.123', 2)).toThrow();
  });
});

describe('address detection', () => {
  const ok = (a: string) => {
    const d = detectAddress(a);
    if (d.kind !== 'address') throw new Error(`${a}: ${d.kind} ${'reason' in d ? d.reason : ''}`);
    return d.candidates;
  };
  it('detects bitcoin', () => {
    expect(ok('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')[0]!.networks).toEqual(['bitcoin']);
    expect(ok('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')[0]!.networks).toEqual(['bitcoin']);
    expect(ok('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')[0]!.description).toContain('Taproot');
  });
  it('flags ambiguous P2SH', () => {
    const c = ok('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
    expect(c.map((x) => x.networks[0])).toEqual(['bitcoin', 'litecoin']);
  });
  it('detects litecoin', () => {
    expect(ok('LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9')[0]!.networks).toEqual(['litecoin']);
    expect(ok('ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt')[0]!.networks).toEqual(['litecoin']);
    expect(detectAddress('ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgx').kind).toBe('invalid');
  });
  it('detects evm', () => {
    const c = ok('0x28c6c06298d514db089934071355e5743bf21d60');
    expect(c[0]!.address).toBe('0x28C6c06298d514Db089934071355E5743bf21d60');
    expect(c[0]!.networks).toEqual(['ethereum', 'bsc', 'polygon', 'base']);
  });
  it('detects solana and xrp', () => {
    expect(ok('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')[0]!.family).toBe('solana');
    expect(ok('rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh')[0]!.family).toBe('xrp');
  });
  it('rejects bad checksums', () => {
    expect(detectAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').kind).toBe('invalid');
    expect(detectAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx').kind).toBe('invalid');
  });
  it('refuses secrets', () => {
    expect(looksLikeSecret('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).toBeTruthy();
    expect(detectAddress('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ').kind).toBe('secret');
    expect(detectAddress('0x' + 'ab'.repeat(32)).kind).toBe('secret');
  });
});
