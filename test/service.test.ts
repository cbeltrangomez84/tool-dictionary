import { describe, expect, it } from 'vitest';
import { DictionaryService, ServiceError } from '../src/service';
import type { IndexResponse, ResultsResponse } from '../src/types';
import { example, nftDictionary } from './helpers';

async function serviceWithExample(): Promise<DictionaryService> {
  const service = new DictionaryService();
  await service.install({ source: { kind: 'inline' } }, example());
  return service;
}

describe('DictionaryService.search', () => {
  it('ranks the obvious entry first and carries related entries', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', { query: 'how many holders' });
    expect(response.kind).toBe('results');
    const r = response as ResultsResponse;
    expect(r.results[0]!.name).toBe('holders_count');
    expect(r.results[0]!.detail).toBe('full');
    expect(r.results[0]!.relations).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'holders_percentage', type: 'alternative' })]));
    expect(r.results.slice(3).every((e) => e.detail === 'summary')).toBe(true);
  });

  it('carries relations strongest first, and never more than five', async () => {
    const dict = example();
    const entry = dict.entries[0]!;
    entry.relations = [
      { type: 'pairs_with', target: dict.entries[1]!.name, reason: 'seeded', weight: 0.3 },
      { type: 'pairs_with', target: dict.entries[2]!.name, reason: 'seeded', weight: 0.3 },
      { type: 'pairs_with', target: dict.entries[3]!.name, reason: 'seeded', weight: 0.3 },
      { type: 'pairs_with', target: dict.entries[4]!.name, reason: 'seeded', weight: 0.3 },
      { type: 'pairs_with', target: dict.entries[5]!.name, reason: 'seeded', weight: 0.3 },
      { type: 'alternative', target: dict.entries[6]!.name, reason: 'written by a human' },
    ];
    const s = new DictionaryService();
    await s.install({ source: { kind: 'inline' } }, dict);
    const { response } = await s.search('crypto-data', { query: entry.name });
    const result = (response as ResultsResponse).results.find((r) => r.name === entry.name)!;
    expect(result.relations).toHaveLength(5);
    // The hand-written one outranks every seed, and `weight` itself never ships.
    expect(result.relations![0]).toEqual({ type: 'alternative', target: dict.entries[6]!.name, reason: 'written by a human' });
    expect(result.relations!.every((r) => !('weight' in r))).toBe(true);
  });

  it('expands synonyms and reports the interpretation', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', { query: 'hodlers' });
    const r = response as ResultsResponse;
    expect(r.kind).toBe('results');
    expect(r.results[0]!.name).toBe('holders_count');
    expect(r.query.interpretedAs).toContain('holder');
  });

  it('reports a synonym only when it appears as whole words, the way the expansion reads it', async () => {
    const s = await serviceWithExample();
    // "help" contains the letters of the `lp` synonym and "mcaps" those of `mcap`; neither is the word.
    const { response } = await s.search('crypto-data', { query: 'help with the token price' });
    const r = response as ResultsResponse;
    expect(r.kind).toBe('results');
    expect(r.query.interpretedAs ?? []).not.toContain('liquidity pool');

    const multi = (await s.search('crypto-data', { query: 'profit and loss of a wallet' })).response as ResultsResponse;
    expect(multi.query.interpretedAs).toContain('pnl');
  });

  it('returns the index with suggestions on a miss, never an empty list', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', { query: 'weather forecast bogota' });
    expect(response.kind).toBe('index');
    const i = response as IndexResponse;
    expect(i.reason).toBe('below_threshold');
    expect(i.index.nodes.length).toBeGreaterThan(0);
    expect(i.index.nodes[0]!.sampleQueries?.length).toBeGreaterThan(0);
  });

  it('suggests near misses on a typo', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', { query: 'holdrs' });
    if (response.kind === 'index') {
      expect(response.suggestions.map((x) => x.name)).toContain('holders_count');
    } else {
      expect(response.results[0]!.name).toMatch(/^holders_/);
    }
  });

  it('returns the index with reason empty_query on an empty query', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', {});
    expect(response).toMatchObject({ kind: 'index', reason: 'empty_query' });
  });

  it('explains an unknown path and a filter that removed everything', async () => {
    const s = await serviceWithExample();
    const unknown = (await s.search('crypto-data', { query: 'holders', path: 'nope' })).response as IndexResponse;
    expect(unknown).toMatchObject({ kind: 'index', reason: 'no_match' });
    expect(unknown.notice).toContain('nope');
    const filtered = (await s.search('crypto-data', { query: 'holders', risk: ['destructive'] })).response as IndexResponse;
    expect(filtered).toMatchObject({ kind: 'index', reason: 'no_match' });
    expect(filtered.notice).toContain('destructive');
    // A path with no hits inside returns the subtree of that path, not the whole tree.
    const subtree = (await s.search('crypto-data', { query: 'market cap', path: 'wallets' })).response as IndexResponse;
    expect(subtree.kind).toBe('index');
    expect(subtree.index.nodes.map((n) => n.path)).toEqual(['wallets']);
  });

  it('clamps bad values with a notice instead of failing', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', { query: 'holders', limit: 500, detail: 'bogus' as never, maxBytes: 10, format: 'xml' as never, bogusField: 1 } as never);
    const r = response as ResultsResponse;
    expect(r.kind).toBe('results');
    expect(r.notice).toMatch(/limit capped at 50/);
    expect(r.notice).toMatch(/maxBytes raised to 1024/);
    expect(r.notice).toMatch(/Unknown detail/);
    expect(r.notice).toMatch(/Unknown format/);
  });

  it('pages with a cursor and ignores a cursor from another query', async () => {
    const s = await serviceWithExample();
    const first = (await s.search('crypto-data', { query: 'token', limit: 2 })).response as ResultsResponse;
    expect(first.results).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await s.search('crypto-data', { query: 'token', limit: 2, cursor: first.nextCursor })).response as ResultsResponse;
    expect(second.results.map((e) => e.name)).not.toEqual(first.results.map((e) => e.name));
    const other = (await s.search('crypto-data', { query: 'wallet', limit: 2, cursor: first.nextCursor })).response as ResultsResponse;
    expect(other.notice).toMatch(/different query/);
  });

  it('never exceeds maxBytes in any format, for every budget from the floor up', async () => {
    const s = await serviceWithExample();
    for (const format of ['json', 'text', 'anthropic_tool_reference'] as const) {
      for (let maxBytes = 1024; maxBytes <= 9000; maxBytes += 233) {
        for (const query of ['holders', 'token', 'wallet pnl per token', '', 'nothing here at all']) {
          const { body, response } = await s.search('crypto-data', { query, maxBytes, format, limit: 50 });
          const used = Buffer.byteLength(body, 'utf8');
          expect(used, `${format} ${maxBytes} "${query}"`).toBeLessThanOrEqual(maxBytes);
          if (format !== 'anthropic_tool_reference') expect(response.budget.usedBytes).toBe(used);
        }
      }
    }
  });

  it('keeps rank 1 at full detail while degrading lower ranks first', async () => {
    const s = await serviceWithExample();
    const { response } = await s.search('crypto-data', { query: 'holders', maxBytes: 3000 });
    const r = response as ResultsResponse;
    expect(r.budget.truncated).toBe(true);
    expect(r.results[0]!.detail).toBe('full');
  });
});

describe('DictionaryService registry', () => {
  it('isolates dictionaries: a search never crosses tenants', async () => {
    const s = await serviceWithExample();
    await s.install({ source: { kind: 'inline' } }, nftDictionary());
    const nft = (await s.search('nft-data', { query: 'holders' })).response as ResultsResponse;
    expect(nft.results.map((e) => e.name)).toEqual(['holders_count']);
    expect(nft.results[0]!.path).toBe('collections');
    const crypto = (await s.search('crypto-data', { query: 'cheapest listing' })).response;
    expect(crypto.kind).toBe('index');
  });

  it('resolves aliases, reports removed entries and rejects stale versions on PUT', async () => {
    const s = new DictionaryService({ globalAdminTokens: ['admin'] });
    const v1 = example();
    await s.install({ source: { kind: 'inline' } }, v1);
    const v2 = example();
    v2.version = 48;
    v2.entries = v2.entries.filter((e) => e.name !== 'holders_top');
    v2.index.nodes[0]!.children![0]!.examples = ['holders_count', 'holders_percentage'];
    for (const e of v2.entries) e.relations = e.relations?.filter((r) => r.target !== 'holders_top');
    v2.entries[0]!.aliases = ['holder_count'];
    await s.put('crypto-data', v2);
    expect(s.getEntry('crypto-data', 'holder_count')).toMatchObject({ resolvedFrom: 'holder_count', entry: { name: 'holders_count' } });
    let err: unknown;
    try { s.getEntry('crypto-data', 'holders_top'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('entry_removed');
    expect((err as ServiceError).details).toEqual([{ removedInVersion: 48 }]);
    await expect(s.put('crypto-data', v1)).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
    // batchGet mixes found, alias, removed and unknown
    const batch = s.batchGet('crypto-data', ['holder_count', 'holders_top', 'zzz']);
    expect(batch.entries.map((e) => e.name)).toEqual(['holders_count']);
    expect(batch.missing).toEqual([
      { name: 'holders_top', code: 'entry_removed', details: [{ removedInVersion: 48 }] },
      { name: 'zzz', code: 'entry_not_found' },
    ]);
  });

  it('keeps the last good version and marks stale when a refresh fails', async () => {
    let calls = 0;
    const s = new DictionaryService({
      fetchJson: async () => {
        calls += 1;
        if (calls === 1) return example();
        throw new Error('upstream down');
      },
    });
    await s.install({ id: 'crypto-data', source: { kind: 'url', location: 'https://x/dict.json' } });
    const status = await s.refresh('crypto-data');
    expect(status).toMatchObject({ loaded: true, version: 47, stale: true, lastRefreshError: 'upstream down' });
    expect(status.staleSince).toBeTruthy();
    expect(s.version('crypto-data').stale).toBe(true);
    const { response } = await s.search('crypto-data', { query: 'holders' });
    expect(response.kind).toBe('results');
  });

  it('refuses an invalid replacement and keeps serving the old one', async () => {
    let calls = 0;
    const s = new DictionaryService({
      fetchJson: async () => {
        calls += 1;
        return calls === 1 ? example() : { toolDictionary: '0.1', id: 'crypto-data' };
      },
    });
    await s.install({ id: 'crypto-data', source: { kind: 'url', location: 'https://x/dict.json' } });
    const status = await s.refresh('crypto-data');
    expect(status.stale).toBe(true);
    expect(status.lastRefreshError).toMatch(/validation/);
    expect(status.version).toBe(47);
  });

  it('enforces read and admin tokens per dictionary', async () => {
    const s = new DictionaryService({ globalAdminTokens: ['root'] });
    await s.install({ source: { kind: 'inline' }, readTokens: ['r1'], adminTokens: ['a1'] }, example());
    expect(() => s.authorize('crypto-data', 'read', undefined)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => s.authorize('crypto-data', 'read', 'wrong')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => s.authorize('crypto-data', 'read', 'r1')).not.toThrow();
    expect(() => s.authorize('crypto-data', 'read', 'a1')).not.toThrow();
    expect(() => s.authorize('crypto-data', 'admin', 'r1')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => s.authorize('crypto-data', 'admin', 'a1')).not.toThrow();
    expect(() => s.authorize('crypto-data', 'admin', 'root')).not.toThrow();
    expect(s.list(undefined)).toEqual([]);
    expect(s.list('r1').map((d) => d.id)).toEqual(['crypto-data']);
  });
});
