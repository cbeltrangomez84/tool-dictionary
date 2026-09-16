import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server';
import { DictionaryService } from '../src/service';
import { example } from './helpers';

let app: FastifyInstance;
let service: DictionaryService;

beforeAll(async () => {
  service = new DictionaryService({ globalAdminTokens: ['root'] });
  await service.install({ source: { kind: 'inline' } }, example());
  app = buildServer({ service, rateLimitPerMinute: 0 });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await service.close();
});

describe('HTTP API', () => {
  it('POST search returns JSON with budget headers', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/search', payload: { query: 'holders', limit: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-budget-used-bytes']).toBe(String(Buffer.byteLength(res.body)));
    expect(res.json()).toMatchObject({ kind: 'results' });
  });

  it('GET search with q= and format=text returns text/plain', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/search?q=holders&format=text&limit=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(/^DICTIONARY crypto-data v47 — 1 result for "holders"/);
  });

  it('a non-object body is treated as an empty query, not a 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/search', payload: '"just a string"', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'index', reason: 'empty_query' });
  });

  it('serves /catalog with Cache-Control and honours If-None-Match', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/catalog' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toMatch(/max-age=\d+, must-revalidate/);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"sha256:/);
    const second = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/catalog', headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
    const version = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/version' });
    expect(version.json()).toMatchObject({ id: 'crypto-data', version: 47, etag, entryCount: 8, stale: false });
  });

  it('returns structured 404s for unknown dictionary, entry and route', async () => {
    const dict = await app.inject({ method: 'GET', url: '/v1/dictionaries/nope/version' });
    expect(dict.statusCode).toBe(404);
    expect(dict.json()).toMatchObject({ error: { code: 'not_found' } });
    const entry = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries/nope' });
    expect(entry.statusCode).toBe(404);
    expect(entry.json()).toMatchObject({ error: { code: 'entry_not_found' } });
    const route = await app.inject({ method: 'GET', url: '/nothing' });
    expect(route.statusCode).toBe(404);
  });

  it('lists every entry as one line, filtered by subtree, in JSON and text', async () => {
    const all = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries' });
    expect(all.statusCode).toBe(200);
    expect(all.headers['cache-control']).toBe('max-age=60, must-revalidate');
    const body = all.json();
    expect(body).toMatchObject({ kind: 'entries', dictionary: { id: 'crypto-data', version: 47 }, path: null, total: 8 });
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual([
      'holders_count',
      'holders_percentage',
      'holders_top',
      'token_resolve_symbol',
      'token_market_cap',
      'token_price',
      'wallet_pnl',
      'wallet_pnl_by_token',
    ]);
    expect(body.entries[0]).toEqual({ name: 'holders_count', title: 'Token holder count', path: 'tokens/holders' });

    const subtree = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries?path=tokens/price' });
    expect(subtree.json()).toMatchObject({ path: 'tokens/price', total: 2 });
    const parent = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries?path=tokens' });
    expect(parent.json().total).toBe(6);
    const nowhere = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries?path=nope' });
    expect(nowhere.statusCode).toBe(200);
    expect(nowhere.json()).toMatchObject({ path: 'nope', total: 0, entries: [] });

    const text = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries?path=wallets&format=text' });
    expect(text.headers['content-type']).toMatch(/text\/plain/);
    expect(text.body).toBe('DICTIONARY crypto-data v47 — 2 entries under "wallets"\nwallet_pnl — Wallet profit and loss\nwallet_pnl_by_token — Wallet profit and loss per token\n');

    const cached = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/entries', headers: { 'if-none-match': all.headers.etag as string } });
    expect(cached.statusCode).toBe(304);
  });

  it('serves the agent bundle with absolute endpoints and the system prompt', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/tool', headers: { host: 'dict.example.com' } });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    expect(bundle.dictionary).toMatchObject({ id: 'crypto-data', version: 47, title: expect.any(String), summary: expect.any(String), entryCount: 8 });
    expect(bundle.tools.map((t: { name: string }) => t.name)).toEqual(['search_tools', 'list_tools']);
    expect(bundle.tools[0]).toMatchObject({ method: 'POST', endpoint: 'http://dict.example.com/v1/dictionaries/crypto-data/search', input_schema: { required: ['query'] } });
    expect(bundle.tools[1]).toMatchObject({ method: 'GET', endpoint: 'http://dict.example.com/v1/dictionaries/crypto-data/entries' });
    expect(bundle.systemPrompt).toMatch(/^You have access to a tool dictionary covering /);
    expect(bundle.systemPrompt).toContain(bundle.dictionary.summary.replace(/\.$/, ''));

    const cached = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/tool', headers: { 'if-none-match': res.headers.etag as string } });
    expect(cached.statusCode).toBe(304);

    const pinned = buildServer({ service, rateLimitPerMinute: 0, publicBaseUrl: 'https://public.example.com/' });
    await pinned.ready();
    const viaProxy = await pinned.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/tool', headers: { host: 'internal:8080' } });
    expect(viaProxy.json().tools[0].endpoint).toBe('https://public.example.com/v1/dictionaries/crypto-data/search');
    await pinned.close();
  });

  it('protects admin routes and validates on PUT', async () => {
    const anon = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/refresh' });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: 'PUT', url: '/v1/dictionaries/crypto-data', headers: { authorization: 'Bearer root' }, payload: { toolDictionary: '0.1', id: 'crypto-data' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.length).toBeGreaterThan(0);
    const mismatch = await app.inject({ method: 'PUT', url: '/v1/dictionaries/other', headers: { authorization: 'Bearer root' }, payload: example() });
    expect(mismatch.statusCode).toBe(422);
    const stale = await app.inject({ method: 'PUT', url: '/v1/dictionaries/crypto-data', headers: { authorization: 'Bearer root' }, payload: example() });
    expect(stale.statusCode).toBe(409);
    const noSource = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/refresh', headers: { authorization: 'Bearer root' } });
    expect(noSource.statusCode).toBe(409);
    expect(noSource.json().error.code).toBe('no_source');
  });

  it('installs a new dictionary via PUT with a global admin token and lists it', async () => {
    const doc = { ...example(), id: 'second', version: 1 };
    const res = await app.inject({ method: 'PUT', url: '/v1/dictionaries/second', headers: { authorization: 'Bearer root' }, payload: doc });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/v1/dictionaries', headers: { host: 'dict.example.com' } });
    const listed = list.json();
    expect(listed.dictionaries.map((d: { id: string }) => d.id).sort()).toEqual(['crypto-data', 'second']);
    const crypto = listed.dictionaries.find((d: { id: string }) => d.id === 'crypto-data');
    expect(crypto).toMatchObject({
      title: example().title,
      summary: example().summary,
      entryCount: 8,
      loaded: true,
      endpoints: {
        search: 'http://dict.example.com/v1/dictionaries/crypto-data/search',
        entries: 'http://dict.example.com/v1/dictionaries/crypto-data/entries',
        tool: 'http://dict.example.com/v1/dictionaries/crypto-data/tool',
      },
    });
    expect(listed.usage).toMatch(/^You have access to 2 tool dictionaries:\n- crypto-data: /);
    expect(listed.usage).toContain('- second: ');
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.json().dictionaries.find((d: { id: string }) => d.id === 'second')).toMatchObject({ threshold: { minScore: 1, relativeFloor: 0.15 }, backend: 'bm25' });
  });

  it('rate limits with Retry-After', async () => {
    const limited = buildServer({ service, rateLimitPerMinute: 2 });
    await limited.ready();
    const url = '/v1/dictionaries/crypto-data/version';
    expect((await limited.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await limited.inject({ method: 'GET', url })).statusCode).toBe(200);
    const third = await limited.inject({ method: 'GET', url });
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    await limited.close();
  });
});
