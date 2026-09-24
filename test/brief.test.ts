import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/agent';
import { applyOverlay } from '../src/generate/overlay';
import { loadDictionary } from '../src/load';
import { renderEntry } from '../src/render/detail';
import { DictionaryService } from '../src/service';
import type { ResultsResponse } from '../src/types';
import { validateDictionary } from '../src/validate';
import { example, nftDictionary } from './helpers';

/** holders_top is the brief of holders_count in every test below. */
function withBrief() {
  const doc = example();
  doc.entries.find((e) => e.name === 'holders_top')!.briefOf = 'holders_count';
  return doc;
}

describe('briefOf (spec 5.6)', () => {
  it('accepts a brief of an entry of the same dictionary', () => {
    expect(validateDictionary(withBrief()).errors).toEqual([]);
  });

  it('rejects an unknown target, itself, a brief of a brief and a second brief', () => {
    const errorsFor = (mutate: (doc: ReturnType<typeof withBrief>) => void) => {
      const doc = withBrief();
      mutate(doc);
      return validateDictionary(doc).errors.filter((e) => e.at.endsWith('.briefOf')).map((e) => e.message);
    };
    const entry = (doc: ReturnType<typeof withBrief>, name: string) => doc.entries.find((e) => e.name === name)!;
    expect(errorsFor((d) => (entry(d, 'holders_top').briefOf = 'nope'))).toEqual(['"nope" is not an entry of this dictionary']);
    expect(errorsFor((d) => (entry(d, 'holders_top').briefOf = 'holders_top'))).toEqual(['an entry cannot be its own brief']);
    expect(errorsFor((d) => (entry(d, 'token_price').briefOf = 'holders_top'))).toEqual(['"holders_top" is itself a brief (of "holders_count")']);
    expect(errorsFor((d) => (entry(d, 'holders_percentage').briefOf = 'holders_count'))).toEqual(['"holders_count" already has a brief, "holders_percentage"']);
  });

  it('materializes brief on the full entry and replaces an authored one', async () => {
    const doc = withBrief();
    doc.entries.find((e) => e.name === 'token_price')!.brief = 'wallet_pnl';
    const loaded = await loadDictionary(doc);
    expect(loaded.byName.get('holders_count')!.brief).toBe('holders_top');
    expect(loaded.byName.get('token_price')!.brief).toBeUndefined();
    expect(loaded.byName.get('holders_top')!.brief).toBeUndefined();
  });

  it('follows a branch rename of the full entry', async () => {
    const parent = example();
    parent.index.nodes.push({ path: 'nfts', title: 'NFTs', summary: 'NFT collections.', branch: { dictionaryId: 'nft-data', url: 'https://nft.example.com/dict.json' } });
    const child = nftDictionary();
    child.entries.find((e) => e.name === 'collection_floor')!.briefOf = 'holders_count';
    const loaded = await loadDictionary(parent, { fetchBranch: async () => child });
    expect(loaded.byName.get('collection_floor')!.briefOf).toBe('nft-data.holders_count');
    expect(loaded.byName.get('nft-data.holders_count')!.brief).toBe('collection_floor');
    expect(loaded.byName.get('holders_count')!.brief).toBeUndefined();
  });

  it('renders both sides from summary detail, not at ref', async () => {
    const loaded = await loadDictionary(withBrief());
    const full = loaded.byName.get('holders_count')!;
    const brief = loaded.byName.get('holders_top')!;
    expect(renderEntry(full, loaded.doc, 'summary').brief).toBe('holders_top');
    expect(renderEntry(brief, loaded.doc, 'summary').briefOf).toBe('holders_count');
    expect(renderEntry(full, loaded.doc, 'ref').brief).toBeUndefined();
  });

  it('prints a BRIEF line on each side in text format', async () => {
    const service = new DictionaryService();
    await service.install({ source: { kind: 'inline' } }, withBrief());
    const { response } = await service.search('crypto-data', { query: 'holders', detail: 'summary' });
    const names = (response as ResultsResponse).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['holders_count', 'holders_top']));
    const { body } = await service.search('crypto-data', { query: 'holders', detail: 'summary', format: 'text' });
    expect(body).toContain('BRIEF: holders_top answers this compactly; prefer it unless you need the full data');
    expect(body).toContain('BRIEF of holders_count: the same answer in a compact response; prefer this one');
  });

  it('patches briefOf from an overlay and drops it when the full entry is hidden', () => {
    const generated = example();
    const set = applyOverlay(generated, { toolDictionaryOverlay: '0.1', dictionaryId: generated.id, entries: { holders_top: { briefOf: 'holders_count' } } });
    expect(set.dictionary.entries.find((e) => e.name === 'holders_top')!.briefOf).toBe('holders_count');
    const hidden = applyOverlay(withBrief(), { toolDictionaryOverlay: '0.1', dictionaryId: generated.id, hide: ['holders_count'] });
    expect(hidden.dictionary.entries.find((e) => e.name === 'holders_top')!.briefOf).toBeUndefined();
    expect(hidden.issues.some((i) => i.at === 'entries "holders_top".briefOf')).toBe(true);
    expect(validateDictionary(hidden.dictionary).errors).toEqual([]);
  });

  it('tells the agent to call the brief first', () => {
    expect(systemPrompt({ id: 'd', title: 'D', summary: 'crypto data.' })).toContain('When a tool has a BRIEF, call the brief');
  });
});
