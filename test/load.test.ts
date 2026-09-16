import { describe, expect, it } from 'vitest';
import { loadDictionary, LoadError } from '../src/load';
import type { Dictionary } from '../src/types';
import { example, nftDictionary } from './helpers';

describe('loadDictionary', () => {
  it('materializes inverse relations without overriding explicit ones', async () => {
    const loaded = await loadDictionary(example());
    const pct = loaded.byName.get('holders_percentage')!;
    // holders_count declares alternative -> holders_percentage; the inverse is materialized.
    expect(pct.relations?.some((r) => r.type === 'alternative' && r.target === 'holders_count')).toBe(true);
    const symbol = loaded.byName.get('token_resolve_symbol')!;
    // prerequisite inverse is enables
    expect(symbol.relations?.some((r) => r.type === 'enables' && r.target === 'holders_count')).toBe(true);
    // No duplicates
    const keys = symbol.relations!.map((r) => `${r.type}:${r.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('recomputes entryCount and resolves aliases', async () => {
    const doc = example();
    doc.index.nodes[0]!.entryCount = 999;
    doc.entries[0]!.aliases = ['holder_count_v1'];
    const loaded = await loadDictionary(doc);
    expect(loaded.nodeByPath.get('tokens')!.entryCount).toBe(6);
    expect(loaded.nodeByPath.get('tokens/holders')!.entryCount).toBe(3);
    expect(loaded.byName.get('holder_count_v1')!.name).toBe('holders_count');
  });

  it('throws LoadError with issues on an invalid document', async () => {
    await expect(loadDictionary({ toolDictionary: '0.1' })).rejects.toBeInstanceOf(LoadError);
  });

  it('merges a branch, re-roots paths, prefixes colliding names and folds defaults', async () => {
    const parent = example();
    parent.index.nodes.push({
      path: 'nfts',
      title: 'NFTs',
      summary: 'NFT collections.',
      branch: { dictionaryId: 'nft-data', url: 'https://nft.example.com/dict.json' },
    });
    const loaded = await loadDictionary(parent, { fetchBranch: async () => nftDictionary() });
    expect(loaded.branches).toEqual([expect.objectContaining({ path: 'nfts', ok: true, version: 3, entryCount: 2 })]);
    expect(loaded.nodeByPath.get('nfts/collections')!.entryCount).toBe(2);
    expect(loaded.nodeByPath.get('nfts')!.entryCount).toBe(2);
    const floor = loaded.byName.get('collection_floor')!;
    expect(floor.path).toBe('nfts/collections');
    expect(floor.call).toMatchObject({ type: 'http', baseUrl: 'https://nft.example.com', auth: { kind: 'caller' } });
    // holders_count collides with the parent's entry: prefixed, bare name kept as alias only if free (it is not).
    const nftHolders = loaded.byName.get('nft-data.holders_count')!;
    expect(nftHolders.path).toBe('nfts/collections');
    expect(nftHolders.aliases ?? []).not.toContain('holders_count');
    expect(loaded.byName.get('holders_count')!.path).toBe('tokens/holders');
    // relations inside the branch were rewritten to the new name
    expect(floor.relations?.some((r) => r.target === 'nft-data.holders_count')).toBe(true);
  });

  it('degrades a branch that fails to load instead of failing the parent', async () => {
    const parent = example();
    parent.index.nodes.push({ path: 'nfts', title: 'NFTs', summary: 'NFT collections.', branch: { dictionaryId: 'nft-data', url: 'https://x/dict.json' } });
    const loaded = await loadDictionary(parent, { fetchBranch: async () => { throw new Error('boom'); } });
    expect(loaded.branches[0]).toMatchObject({ ok: false, error: 'boom' });
    expect(loaded.nodeByPath.get('nfts')!.degraded).toBe(true);
    expect(loaded.doc.entries).toHaveLength(8);
  });

  it('detects a branch cycle', async () => {
    const parent = example();
    parent.index.nodes.push({ path: 'self', title: 'Self', summary: 'Cycle.', branch: { dictionaryId: 'crypto-data', url: 'https://x/self.json' } });
    const loaded = await loadDictionary(parent, { fetchBranch: async () => example() as Dictionary });
    expect(loaded.branches[0]!.error).toMatch(/cycle/);
  });

  it('rejects a branch whose id does not match the declaration', async () => {
    const parent = example();
    parent.index.nodes.push({ path: 'nfts', title: 'NFTs', summary: 'x', branch: { dictionaryId: 'nft-data', url: 'https://x/d.json' } });
    const loaded = await loadDictionary(parent, { fetchBranch: async () => nftDictionary({ id: 'other' }) });
    expect(loaded.branches[0]!.error).toMatch(/expected "nft-data"/);
  });
});
