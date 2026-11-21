import { describe, expect, it } from 'vitest';
import { detectAddress } from '../src/core/address.ts';
import { base58CheckDecode, base58CheckEncode } from '../src/core/encoding.ts';
import { candidateTypes, descriptorFor, isXpubQuery, parseExtendedKey } from '../src/core/xpub.ts';
import { planWallet } from '../src/wallets/manage.ts';

// Public BIP84 / BIP44 test vectors ("abandon ... about"), safe to use.
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const XPUB44 = 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';

describe('extended public keys', () => {
  it('round-trips base58check', () => {
    expect(base58CheckEncode(base58CheckDecode(ZPUB)!)).toBe(ZPUB);
    expect(base58CheckEncode(base58CheckDecode(XPUB44)!)).toBe(XPUB44);
  });

  it('parses and normalizes to xpub version bytes', () => {
    const z = parseExtendedKey(ZPUB)!;
    expect(z.type).toBe('wpkh');
    expect(z.xpub.startsWith('xpub')).toBe(true);
    expect(descriptorFor(z, 'wpkh')).toBe(`wpkh(${z.xpub})`);
    const x = parseExtendedKey(XPUB44)!;
    expect(x.type).toBeNull();
    expect(x.xpub).toBe(XPUB44);
    expect(candidateTypes(x, 'bitcoin')).toEqual(['wpkh', 'tr', 'sh-wpkh', 'pkh']);
    expect(candidateTypes(x, 'litecoin')).not.toContain('tr');
  });

  it('rejects corrupted keys and private keys', () => {
    expect(parseExtendedKey(ZPUB.slice(0, -1) + 't')).toBeNull();
    expect(
      detectAddress('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi').kind,
    ).toBe('secret');
  });

  it('detects as a trackable address, Bitcoin unless told otherwise', () => {
    const d = detectAddress(XPUB44);
    expect(d.kind).toBe('address');
    const plan = planWallet(XPUB44, 'auto');
    expect(plan.ok && plan.plan.networks).toEqual(['bitcoin']);
    const ltc = planWallet(XPUB44, ['litecoin']);
    expect(ltc.ok && ltc.plan.networks).toEqual(['litecoin']);
  });

  it('routes descriptors and keys to the xpub endpoint only', () => {
    expect(isXpubQuery(`wpkh(${XPUB44})`)).toBe(true);
    expect(isXpubQuery(ZPUB)).toBe(true);
    expect(isXpubQuery('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false);
  });
});
