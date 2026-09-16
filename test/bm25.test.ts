import { describe, expect, it } from 'vitest';
import { Bm25Backend } from '../src/search/bm25';
import type { Entry } from '../src/types';

const entry = (name: string, title: string, keywords: string[]): Entry => ({
  name,
  title,
  summary: title,
  path: 'tools',
  keywords,
  input: { type: 'object', properties: {} },
  call: { type: 'http', method: 'GET', urlTemplate: `/${name}` },
});

const ENTRIES: Entry[] = [
  entry('holders_count', 'How many wallets hold a token', ['token', 'holder', 'count', 'wallet', 'hold']),
  entry('wallet_holdings', 'What a wallet holds', ['portfolio', 'wallet', 'holding', 'hold']),
];

describe('Bm25Backend coordination factor', () => {
  it('prefers the entry that answers the whole question over one that answers part of it loudly', async () => {
    const backend = new Bm25Backend();
    await backend.index(ENTRIES);
    const hits = await backend.search('how many wallets hold a token', { limit: 5 });
    expect(hits[0]?.name).toBe('holders_count'); // covers wallet + hold + token
    await backend.close();
  });

  it('penalizes partial coverage, and coordFloor = 1 switches the penalty off', async () => {
    const score = async (coordFloor: number, name: string) => {
      const backend = new Bm25Backend({ coordFloor });
      await backend.index(ENTRIES);
      const hits = await backend.search('how many wallets hold a token', { limit: 5 });
      await backend.close();
      return hits.find((h) => h.name === name)?.score ?? 0;
    };
    // wallet_holdings covers 2 of the 3 query words; holders_count covers all 3.
    expect(await score(0.4, 'wallet_holdings')).toBeLessThan(await score(1, 'wallet_holdings'));
    expect(await score(0.4, 'holders_count')).toBe(await score(1, 'holders_count'));
  });

  it('a synonym covers the word it stands for', async () => {
    const backend = new Bm25Backend();
    await backend.index(ENTRIES, { hold: ['own'] });
    const [withSynonym] = await backend.search('wallets that own a token', { limit: 1 });
    expect(withSynonym?.name).toBe('holders_count');
    await backend.close();
  });

  it('single-word queries are unaffected by coverage', async () => {
    const backend = new Bm25Backend();
    await backend.index(ENTRIES);
    const hits = await backend.search('portfolio', { limit: 5 });
    expect(hits[0]?.name).toBe('wallet_holdings');
    await backend.close();
  });
});
