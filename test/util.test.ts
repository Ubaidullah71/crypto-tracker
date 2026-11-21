import { describe, expect, it } from 'vitest';
import { setConfigForTests } from '../src/config.ts';
import { redact, registerSecret } from '../src/logger.ts';
import { EndpointPool, FatalRequestError } from '../src/util/http.ts';
import { localDay, parseHhMm, periodRange, zonedMidnight } from '../src/util/time.ts';

setConfigForTests({});

describe('redaction', () => {
  it('removes api keys, proxy credentials and registered secrets', () => {
    registerSecret('super-secret-token-123');
    expect(redact('https://api.etherscan.io/v2/api?chainid=1&apikey=ABC123&x=1')).toBe(
      'https://api.etherscan.io/v2/api?chainid=1&apikey=[redacted]&x=1',
    );
    expect(redact('http://user:pass@proxy.example:8080')).toBe('http://[redacted]@proxy.example:8080');
    expect(redact('token super-secret-token-123 leaked')).toBe('token [redacted] leaked');
  });
});

describe('endpoint failover', () => {
  it('falls through to the next endpoint and remembers failures', async () => {
    const pool = new EndpointPool('test', ['https://a.example', 'https://b.example']);
    const seen: string[] = [];
    const r = await pool.run(async (u) => {
      seen.push(u);
      if (u.includes('a.example')) throw new Error('down');
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(seen).toEqual(['https://a.example', 'https://b.example']);
    // a is cooling down now, so b is tried first
    const seen2: string[] = [];
    await pool.run(async (u) => (seen2.push(u), 'ok'));
    expect(seen2[0]).toBe('https://b.example');
  });

  it('stops on fatal errors', async () => {
    const pool = new EndpointPool('test2', ['https://a.example', 'https://b.example']);
    let calls = 0;
    await expect(
      pool.run(async () => {
        calls++;
        throw new FatalRequestError('bad key');
      }),
    ).rejects.toThrow('bad key');
    expect(calls).toBe(1);
  });
});

describe('time zones', () => {
  it('computes local midnight and periods', () => {
    // 2026-11-20 00:00 in Kolkata (UTC+5:30) is 2026-11-19 18:30 UTC
    expect(new Date(zonedMidnight('Asia/Kolkata', 2026, 11, 20)).toISOString()).toBe('2026-11-19T18:30:00.000Z');
    expect(localDay('Asia/Kolkata', Date.UTC(2026, 10, 19, 19, 0))).toBe('2026-11-20');
    const now = Date.UTC(2026, 10, 20, 12, 0);
    const m = periodRange('last_month', 'UTC', now);
    expect(new Date(m.from * 1000).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(new Date(m.to * 1000).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(m.label).toBe('October 2026');
    expect(periodRange('this_year', 'UTC', now).label).toBe('2026');
    expect(parseHhMm('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseHhMm('24:00')).toBeNull();
  });
});
