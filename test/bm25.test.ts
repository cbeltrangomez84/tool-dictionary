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

  it('a multi-word synonym holding a stopword still expands', async () => {
    const backend = new Bm25Backend();
    const pnl = entry('wallet_pnl', 'Realized gains of a wallet', ['pnl', 'wallet']);
    await backend.index([...ENTRIES, pnl], { pnl: ['profit and loss'] });
    const [hit] = await backend.search('profit and loss', { limit: 1 });
    expect(hit?.name).toBe('wallet_pnl');
    await backend.close();
  });

  it('the rare word of the question weighs more than the common one', async () => {
    // "tokens" is everywhere, "fomo" is in one entry: the entry that has the
    // rare word outranks the ones that repeat the common word loudly.
    const common = ['sector_tokens', 'trending_tokens', 'new_tokens', 'token_tags'].map((n) =>
      entry(n, `${n.replace('_', ' ')} tokens token list`, ['tokens', 'token', 'tokens list']),
    );
    const fomo = entry('board_buys', 'What a trader board is buying', ['fomo', 'board buys', 'tokens']);
    const backend = new Bm25Backend();
    await backend.index([...common, fomo]);
    const hits = await backend.search('tokens from fomo', { limit: 5 });
    expect(hits[0]?.name).toBe('board_buys');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score * 2);
    await backend.close();
  });

  it('a word no entry contains does not shrink every score', async () => {
    const backend = new Bm25Backend();
    await backend.index(ENTRIES);
    const [plain] = await backend.search('wallet portfolio', { limit: 1 });
    const [typo] = await backend.search('wallet portfolio xyzzy', { limit: 1 });
    expect(typo?.name).toBe('wallet_holdings');
    expect(typo?.score).toBe(plain?.score);
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

describe('Bm25Backend exact match', () => {
  // Entries that repeat the question's words in every field, and one whose keyword IS the question.
  const loud = ['board_buys', 'board_trades', 'board_traders'].map((n) =>
    entry(n, `fomo traders token ${n}`, ['fomo traders', 'fomo token', 'traders token', 'fomo traders token buys']),
  );
  const whosIn = entry('whos_in', 'Which board wallets hold one coin', ['fomo traders in this token']);

  it('an entry whose keyword is the whole question outranks every partial match', async () => {
    const backend = new Bm25Backend();
    await backend.index([...loud, whosIn]);
    const hits = await backend.search('fomo traders in this token', { limit: 5 });
    expect(hits[0]?.name).toBe('whos_in');
    expect(hits[0]?.matchedOn).toContain('keywords');
    // One word more and the question is no longer its keyword: the entry falls behind
    // the loud ones, so the exact match is what put it first.
    const partial = await backend.search('fomo traders in this token now', { limit: 5 });
    expect(partial[0]?.name).not.toBe('whos_in');
    await backend.close();
  });

  it('several exact hits keep their own order among themselves', async () => {
    const a = entry('a_rich', 'fomo traders token fomo traders', ['fomo traders in this token', 'fomo', 'traders']);
    const b = entry('b_plain', 'Something else', ['fomo traders in this token']);
    const backend = new Bm25Backend();
    await backend.index([...loud, a, b]);
    const hits = await backend.search('fomo traders in this token', { limit: 5 });
    expect(hits.slice(0, 2).map((h) => h.name)).toEqual(['a_rich', 'b_plain']);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
    await backend.close();
  });
});
