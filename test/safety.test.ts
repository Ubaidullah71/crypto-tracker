import { EmbedBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMock = vi.hoisted(() => ({ impl: async (_url: string): Promise<unknown> => [] }));
vi.mock('../src/util/http.ts', async (orig) => {
  const real = await orig<typeof import('../src/util/http.ts')>();
  return { ...real, httpJson: (url: string) => httpMock.impl(url) };
});

import { setConfigForTests } from '../src/config.ts';
import { openDb } from '../src/db/database.ts';
import { addFieldsCapped, embedLength, fieldValue, safe } from '../src/discord/theme.ts';
import { table } from '../src/util/table.ts';
import { PriceService } from '../src/prices/prices.ts';
import { HttpError } from '../src/util/http.ts';

setConfigForTests({});

describe('embed safety', () => {
  it('neutralizes masked links and headings from remote text', () => {
    const s = safe('[Secure your wallet](https://phish.example)\n# Alert');
    expect(s).not.toMatch(/(^|[^\\])\[[^\]]*\]\(/);
    expect(s).toContain('\\[');
    expect(s).not.toMatch(/^# /m);
  });

  it('never cuts a table or field in the middle of a code block', () => {
    const rows = Array.from({ length: 60 }, (_, k) => [`Wallet number ${k}`, `$${(k * 1234.5).toFixed(2)}`, `${k}%`]);
    const t = table(
      [
        { header: 'WALLET', max: 14 },
        { header: 'VALUE', align: 'right' },
        { header: 'SHARE', align: 'right' },
      ],
      rows,
    );
    expect(t.length).toBeLessThanOrEqual(1024);
    expect((t.match(/```/g) ?? []).length).toBe(2);
    expect(t).toMatch(/\.\.\.and \d+ more$/);
    const long = '```\n' + 'x'.repeat(40).concat('\n').repeat(40) + '```';
    const v = fieldValue(long);
    expect(v.length).toBeLessThanOrEqual(1024);
    expect((v.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('caps embeds at Discord limits', () => {
    const e = new EmbedBuilder().setTitle('Wallets').setDescription('x'.repeat(200));
    const fields = Array.from({ length: 40 }, (_, k) => ({ name: `Wallet ${k}`, value: 'y'.repeat(900) }));
    addFieldsCapped(e, fields, (n) => `${n} more`);
    const j = e.toJSON();
    expect(j.fields!.length).toBeLessThanOrEqual(25);
    expect(embedLength(e)).toBeLessThanOrEqual(6000);
    expect(j.fields!.at(-1)!.name).toBe('More');
  });
});

describe('historical prices', () => {
  beforeEach(() => openDb(':memory:'));

  it('retries later on transient failures instead of giving up', async () => {
    httpMock.impl = async (url) => {
      throw new HttpError('HTTP 503', 503, url, true);
    };
    await expect(new PriceService().getHistoricalPrice('BTC', 1_700_000_000)).rejects.toThrow(/temporarily unavailable/);
  });

  it('reports "no data" only when every source answers definitively', async () => {
    httpMock.impl = async (url) => {
      if (url.includes('coingecko')) throw new HttpError('HTTP 401', 401, url, false);
      if (url.includes('coinbase')) throw new HttpError('HTTP 404', 404, url, false);
      return [];
    };
    await expect(new PriceService().getHistoricalPrice('XRP', 1_500_000_000)).resolves.toBeNull();
  });

  it('uses the first source that has data and caches it', async () => {
    let calls = 0;
    httpMock.impl = async () => {
      calls++;
      return [[1_700_000_000_000, '100', '101', '99', '102']];
    };
    const ps = new PriceService();
    expect(await ps.getHistoricalPrice('LTC', 1_700_000_000)).toEqual({ price: 101, source: 'binance:LTCUSDT' });
    expect(await ps.getHistoricalPrice('LTC', 1_700_000_010)).toEqual({ price: 101, source: 'binance:LTCUSDT' });
    expect(calls).toBe(1);
  });
});
