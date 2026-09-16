import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateFromOpenApi, GenerateError, slugify } from '../src/generate/openapi';
import { applyOverlay, OverlayError } from '../src/generate/overlay';
import { flattenNodes, validateDictionary } from '../src/validate';
import { DictionaryService } from '../src/service';
import { effectiveCall } from '../src/load';
import type { Dictionary, Entry, HttpCall } from '../src/types';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const openapiDoc = () => JSON.parse(readFileSync(path.join(FIXTURES, 'sample-openapi.json'), 'utf8')) as unknown;
const overlayDoc = () => JSON.parse(readFileSync(path.join(FIXTURES, 'sample-overlay.json'), 'utf8')) as unknown;

const generate = (doc: unknown = openapiDoc()) =>
  generateFromOpenApi(doc, { id: 'sample', version: 1, sourceUrl: 'file://sample-openapi.json', generatedAt: '2026-09-15T00:00:00.000Z' });

const entryOf = (dict: Dictionary, name: string): Entry => {
  const entry = dict.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no entry ${name} (have: ${dict.entries.map((e) => e.name).join(', ')})`);
  return entry;
};

describe('generateFromOpenApi', () => {
  it('produces a dictionary that validates', () => {
    const { dictionary } = generate();
    const result = validateDictionary(dictionary);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is deterministic: the same document yields byte-identical output', () => {
    expect(JSON.stringify(generate().dictionary)).toBe(JSON.stringify(generate().dictionary));
  });

  it('names from operationId, falls back to method + segments, and breaks collisions', () => {
    const { dictionary, notes } = generate();
    const names = dictionary.entries.map((e) => e.name);
    expect(names).toContain('token_price'); // operationId
    expect(names).toContain('get_wallets_pnl'); // no operationId → method + plain segments
    expect(names).toContain('wallet_holdings'); // "wallet holdings!" sanitized
    expect(names).toContain('create_alert');
    expect(names).toContain('create_alert_2'); // duplicated operationId
    expect(notes.some((n) => n.includes('name collision'))).toBe(true);
  });

  it('spells out path parameters only when the short name would be ambiguous', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Markets', version: '1.0.0' },
      paths: {
        '/markets/{id}': { get: { summary: 'One market', responses: { '200': { description: 'A market.' } } } },
        '/markets/{id}/{venue}': { get: { summary: 'One market on one venue', responses: { '200': { description: 'A market.' } } } },
        '/venues': { get: { summary: 'Every venue', responses: { '200': { description: 'Venues.' } } } },
      },
    };
    const { dictionary } = generateFromOpenApi(doc, { id: 'markets', version: 1, sourceUrl: 'file://markets.json', generatedAt: '2026-09-15T00:00:00.000Z' });
    const names = dictionary.entries.map((e) => e.name).sort();
    // Both /markets routes shorten to `get_markets`, so both keep their parameters;
    // /venues is unambiguous and stays short.
    expect(names).toEqual(['get_markets_by_id', 'get_markets_by_id_by_venue', 'get_venues']);
  });

  it('drops placeholder response descriptions instead of repeating them as returns', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Placeholder', version: '1.0.0' },
      paths: {
        '/a': { get: { summary: 'A', responses: { '200': { description: 'Default Response' } } } },
        '/b': { get: { summary: 'B', responses: { '200': { description: 'OK' } } } },
        '/c': { get: { summary: 'C', responses: { '200': { description: 'The current price in USD.' } } } },
      },
    };
    const { dictionary, notes } = generateFromOpenApi(doc, { id: 'ph', version: 1, sourceUrl: 'file://ph.json', generatedAt: '2026-09-15T00:00:00.000Z' });
    expect(entryOf(dictionary, 'get_a').returns).toBeUndefined();
    expect(entryOf(dictionary, 'get_b').returns).toBeUndefined();
    expect(entryOf(dictionary, 'get_c').returns).toBe('The current price in USD.');
    expect(notes.some((n) => n.includes('placeholder') && n.includes('get_a'))).toBe(true);
  });

  it('falls back to the response schema when the description is a placeholder', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Shapes', version: '1.0.0' },
      paths: {
        '/quote': {
          get: {
            summary: 'Quote',
            responses: {
              '200': {
                description: 'Default Response',
                content: { 'application/json': { schema: { type: 'object', properties: { usd: { type: ['null', 'number'] }, corroborated: { type: 'boolean' } } } } },
              },
            },
          },
        },
        '/owners': {
          get: {
            summary: 'Owners',
            responses: {
              '200': {
                description: 'Default Response',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, balance: { type: 'number' } } } } } },
              },
            },
          },
        },
        '/ping': { get: { summary: 'Ping', responses: { '200': { description: 'Default Response' } } } },
      },
    };
    const { dictionary, notes } = generateFromOpenApi(doc, { id: 'shapes', version: 1, sourceUrl: 'file://shapes.json', generatedAt: '2026-09-15T00:00:00.000Z' });
    expect(entryOf(dictionary, 'get_quote').returns).toBe('An object with usd, corroborated.');
    expect(entryOf(dictionary, 'get_owners').returns).toBe('An array of objects with address, balance.');
    // Nothing to read: that one is the author's problem, and it is reported.
    expect(entryOf(dictionary, 'get_ping').returns).toBeUndefined();
    expect(notes.some((n) => n.includes('get_ping'))).toBe(true);
  });

  it('keeps a sentence-long summary as the summary and derives a short title', () => {
    const sentence = 'How many wallets provide liquidity to this pool, how they got in, which way the count is moving, and what that implies';
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Providers', version: '1.0.0' },
      paths: { '/providers/{chain}/{pool}': { get: { summary: sentence, responses: { '200': { description: 'Provider counts.' } } } } },
    };
    const { dictionary, notes } = generateFromOpenApi(doc, { id: 'h', version: 1, sourceUrl: 'file://h.json', generatedAt: '2026-09-15T00:00:00.000Z' });
    expect(validateDictionary(dictionary).errors).toEqual([]);
    const entry = entryOf(dictionary, 'get_providers');
    expect(entry.title).toBe('Providers');
    expect(entry.summary).toBe(sentence);
    expect(notes.some((n) => n.includes('longer than 80 chars for a title'))).toBe(true);
  });

  it('relates operations that answer different questions about the same inputs', () => {
    const facet = (name: string) => ({
      get: { summary: `Pool ${name}`, tags: ['pools'], responses: { '200': { description: `The ${name}.` } } },
    });
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Facets', version: '1.0.0' },
      paths: {
        '/depth/{chain}/{pool}': facet('depth'),
        '/volume/{chain}/{pool}': facet('volume'),
        '/status': { get: { summary: 'Status', tags: ['pools'], responses: { '200': { description: 'Status.' } } } },
      },
    };
    const { dictionary } = generateFromOpenApi(doc, { id: 'facets', version: 1, sourceUrl: 'file://facets.json', generatedAt: '2026-09-15T00:00:00.000Z' });
    const depth = entryOf(dictionary, 'get_depth');
    expect(depth.relations).toEqual([{ type: 'pairs_with', target: 'get_volume', reason: 'same inputs: chain, pool', weight: 0.3 }]);
    // Nothing is invented for the operation that shares no inputs.
    expect(entryOf(dictionary, 'get_status').relations).toBeUndefined();
  });

  it('skips x-hidden operations', () => {
    const { dictionary, notes } = generate();
    expect(dictionary.entries.some((e) => e.name === 'debug_dump')).toBe(false);
    expect(notes.some((n) => n.includes('x-hidden'))).toBe(true);
  });

  it('resolves $ref parameters and $ref request bodies', () => {
    const { dictionary } = generate();
    const price = entryOf(dictionary, 'token_price');
    const chain = (price.input.properties as Record<string, { enum?: string[] }>).chain;
    expect(chain?.enum).toEqual(['solana', 'ethereum']); // came from components.parameters
    const alert = entryOf(dictionary, 'create_alert');
    expect(Object.keys(alert.input.properties as object)).toEqual(['address', 'threshold', 'note']);
    expect(alert.input.required).toEqual(['address', 'threshold']);
    expect((alert.call as HttpCall).bodyTemplate).toEqual({ address: '{address}', threshold: '{threshold}', note: '{note}' });
  });

  it('maps path parameters into the url template and declares undeclared ones', () => {
    const { dictionary, notes } = generate();
    const holders = entryOf(dictionary, 'holders_count');
    expect((holders.call as HttpCall).urlTemplate).toBe('/tokens/{address}/holders');
    expect(holders.input.required).toContain('address');
    expect(notes.some((n) => n.includes('path parameter "address" is not declared'))).toBe(true);
  });

  it('never carries credential headers into the input', () => {
    const { dictionary } = generate();
    const price = entryOf(dictionary, 'token_price');
    expect(Object.keys(price.input.properties as object)).not.toContain('X-Api-Key');
    expect((price.call as HttpCall).headers).toBeUndefined();
    expect(dictionary.defaults?.auth).toEqual({ kind: 'caller', in: 'header', name: 'X-Api-Key', value: '{{SAMPLE_API_KEY}}' });
    expect(dictionary.defaults?.variables).toEqual({ SAMPLE_API_KEY: { secret: true, description: 'Issued per tenant in the sample dashboard.' } });
  });

  it('turns security requirements into auth placement, with exceptions per entry', () => {
    const { dictionary } = generate();
    // The majority scheme lives in defaults; entries that use it carry nothing.
    expect(entryOf(dictionary, 'token_price').call.auth).toBeUndefined();
    // An operation that opts out (`security: []`) says so, or it would inherit the default.
    expect(entryOf(dictionary, 'holders_count_v0').call.auth).toEqual({ kind: 'none' });
    expect(validateDictionary(dictionary).errors).toEqual([]);
  });

  it('expresses bearer, basic, query keys and cookies the way an executor can act on', () => {
    const doc = openapiDoc() as { security?: unknown; components: { securitySchemes?: unknown }; paths: unknown };
    delete doc.security;
    doc.components.securitySchemes = {
      bearer: { type: 'http', scheme: 'bearer' },
      basic: { type: 'http', scheme: 'basic' },
      qkey: { type: 'apiKey', in: 'query', name: 'key' },
      hkey: { type: 'apiKey', in: 'header', name: 'X-Key' },
      cookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
    };
    const ops = doc.paths as Record<string, Record<string, { security?: unknown }>>;
    ops['/tokens/{address}/price']!.get!.security = [{ bearer: [] }];
    ops['/tokens/{address}/holders']!.get!.security = [{ basic: [] }];
    ops['/tokens/{address}/holders/legacy']!.get!.security = [{ qkey: [] }];
    ops['/wallets/{wallet}/holdings']!.get!.security = [{ hkey: [] }];
    ops['/alerts']!.post!.security = [{ cookie: [] }];
    const { dictionary } = generate(doc);
    // Every scheme is used once, so one of them is hoisted to defaults; what the executor sees is the same either way.
    const authOf = (name: string) => (effectiveCall(entryOf(dictionary, name), dictionary) as HttpCall).auth;
    expect(authOf('token_price')).toEqual({ kind: 'caller', in: 'header', name: 'Authorization', value: 'Bearer {{SAMPLE_TOKEN}}' });
    expect(authOf('holders_count')).toEqual({ kind: 'caller', in: 'header', name: 'Authorization', value: 'Basic {{SAMPLE_BASIC_AUTH}}' });
    expect(authOf('holders_count_v0')).toEqual({ kind: 'caller', in: 'query', name: 'key', value: '{{SAMPLE_QKEY}}' });
    expect(authOf('wallet_holdings')).toEqual({ kind: 'caller', in: 'header', name: 'X-Key', value: '{{SAMPLE_HKEY}}' });
    expect(authOf('create_alert')).toEqual({ kind: 'caller', hint: "sid cookie, supplied by the caller's backend" });
    expect(Object.keys(dictionary.defaults?.variables ?? {})).toEqual(['SAMPLE_BASIC_AUTH', 'SAMPLE_HKEY', 'SAMPLE_QKEY', 'SAMPLE_TOKEN']);
    expect(validateDictionary(dictionary).errors).toEqual([]);
  });

  it('leaves auth alone when the document declares schemes it never applies', () => {
    const doc = openapiDoc() as { security?: unknown };
    delete doc.security;
    const { dictionary } = generate(doc);
    expect(dictionary.defaults?.auth).toBeUndefined();
    expect(dictionary.defaults?.variables).toBeUndefined();
    expect(dictionary.entries.every((e) => e.call.auth === undefined)).toBe(true);
  });

  it('wraps a non-object request body in a single `body` property', () => {
    const { dictionary } = generate();
    const note = entryOf(dictionary, 'set_alert_note');
    expect((note.input.properties as Record<string, { type?: string }>).body?.type).toBe('string');
    expect((note.call as HttpCall).bodyTemplate).toBe('{body}');
    expect(note.input.required).toContain('body');
  });

  it('assigns risk by method', () => {
    const { dictionary } = generate();
    expect(entryOf(dictionary, 'token_price').risk).toBe('read');
    expect(entryOf(dictionary, 'create_alert').risk).toBe('write');
    expect(entryOf(dictionary, 'set_alert_note').risk).toBe('write');
    expect(entryOf(dictionary, 'create_alert_2').risk).toBe('destructive'); // DELETE /alerts
  });

  it('turns x-replaced-by into a successor and never leaves a deprecated entry silent', () => {
    const { dictionary, notes } = generate();
    const legacy = entryOf(dictionary, 'holders_count_v0');
    expect(legacy.stability).toBe('deprecated');
    expect(legacy.deprecation?.replacedBy).toBe('holders_count');
    expect(legacy.relations?.some((r) => r.type === 'successor' && r.target === 'holders_count')).toBe(true);

    const orphan = entryOf(dictionary, 'get_tokens_trending');
    expect(orphan.stability).toBe('deprecated');
    expect(orphan.deprecation?.note).toBeTruthy(); // spec 17.1 rule 7
    expect(notes.some((n) => n.includes('deprecated with no x-replaced-by'))).toBe(true);
  });

  it('drops deprecated operations when asked', () => {
    const { dictionary } = generateFromOpenApi(openapiDoc(), {
      id: 'sample',
      version: 1,
      sourceUrl: 'x',
      includeDeprecated: false,
    });
    expect(dictionary.entries.some((e) => e.stability === 'deprecated')).toBe(false);
    expect(validateDictionary(dictionary).ok).toBe(true);
  });

  it('builds the index from tags and x-category, nesting and sorting the tree', () => {
    const { dictionary } = generate();
    const roots = dictionary.index.nodes.map((n) => n.path);
    expect(roots).toEqual(['alerts', 'tokens', 'wallets']);
    const tokens = dictionary.index.nodes.find((n) => n.path === 'tokens');
    expect(tokens?.title).toBe('Tokens'); // a slug-shaped tag is a path, not a title
    expect(tokens?.summary).toBe('Token prices and market data.'); // tag description
    expect(tokens?.sampleQueries?.length).toBeGreaterThan(0);
    const wallets = dictionary.index.nodes.find((n) => n.path === 'wallets');
    expect(wallets?.children?.map((c) => c.path)).toEqual(['wallets/positions']); // x-category
    // A grouping node with no entries of its own still offers a query that works.
    expect(wallets?.sampleQueries?.length).toBeGreaterThan(0);
  });

  it('seeds pairs_with between siblings on the same resource', () => {
    const { dictionary } = generate();
    const price = entryOf(dictionary, 'token_price');
    expect(price.relations?.some((r) => r.type === 'pairs_with' && r.target === 'holders_count')).toBe(true);
    expect(price.relations?.every((r) => (r.weight ?? 1) <= 0.3 || r.type === 'successor')).toBe(true);
  });

  it('records the source and the base URL with server variables substituted', () => {
    const { dictionary } = generate();
    expect(dictionary.defaults?.baseUrl).toBe('https://api.example.com/v1');
    expect(dictionary.sources?.[0]).toMatchObject({ type: 'openapi', url: 'file://sample-openapi.json', etag: 'api-version:2.4.0', entryCount: dictionary.entries.length });
  });

  it('rejects documents it cannot generate from', () => {
    expect(() => generateFromOpenApi({ swagger: '2.0' }, { id: 'x', version: 1, sourceUrl: 'x' })).toThrow(GenerateError);
    expect(() => generateFromOpenApi({ openapi: '3.0.0' }, { id: 'x', version: 1, sourceUrl: 'x' })).toThrow(/no paths/);
    expect(() => generateFromOpenApi({ openapi: '3.0.0', paths: {} }, { id: 'x', version: 1, sourceUrl: 'x' })).toThrow(/no operations/);
  });

  it('survives a recursive $ref', () => {
    const doc = openapiDoc() as { paths: Record<string, unknown> };
    doc.paths['/recursive'] = {
      post: {
        operationId: 'recursive_op',
        summary: 'Recursive body',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Recursive' } } } },
        responses: { '200': { description: 'OK' } },
      },
    };
    const { dictionary } = generate(doc);
    expect(entryOf(dictionary, 'recursive_op')).toBeTruthy();
    expect(validateDictionary(dictionary).ok).toBe(true);
  });

  it('slugify keeps the path charset', () => {
    expect(slugify('Token Prices!')).toBe('token-prices');
    expect(slugify('  A/B  ')).toBe('a-b');
  });

  it('generated output is servable: the service loads it and search finds a tool', async () => {
    const { dictionary } = generate();
    const service = new DictionaryService();
    await service.install({ id: 'sample', source: { kind: 'inline' } }, dictionary);
    const built = await service.search('sample', { query: 'price of a token' });
    const body = JSON.parse(built.body) as { results?: { name: string }[] };
    expect(body.results?.[0]?.name).toBe('token_price');
    service.close();
  });
});

describe('applyOverlay', () => {
  it('merges scalars, patches lists, adds relations and reports stale keys', () => {
    const { dictionary: generated } = generate();
    const { dictionary, issues } = applyOverlay(generated, overlayDoc());

    expect(dictionary.summary).toBe('Prices, holders, wallet positions and price alerts for tokens on Solana and Ethereum.');
    expect(dictionary.synonyms?.holders).toEqual(['holder count', 'how many wallets']);

    const holders = entryOf(dictionary, 'holders_count');
    expect(holders.summary).toBe('How many distinct wallets hold this token right now.');
    expect(holders.keywords).toContain('holder count');
    expect(holders.keywords).not.toContain('chain');
    expect(holders.aliases).toEqual(['token_holders']);
    expect(holders.relations?.some((r) => r.type === 'alternative' && r.target === 'token_price')).toBe(true);
    // The seeded relations survive the patch.
    expect(holders.relations?.some((r) => r.type === 'pairs_with')).toBe(true);

    const tokens = dictionary.index.nodes.find((n) => n.path === 'tokens');
    expect(tokens?.summary).toBe('Everything keyed by a token address: price, holders, trending.');
    expect(tokens?.sampleQueries).toContain('price of a token');
    expect(tokens?.sampleQueries).not.toContain('how many wallets hold a token');

    expect(issues.map((i) => i.at).sort()).toEqual(['entries "renamed_upstream"', 'hide "never_existed"', 'index "nowhere"']);
  });

  it('hides entries and cleans up every reference to them', () => {
    const { dictionary: generated } = generate();
    const { dictionary } = applyOverlay(generated, overlayDoc());
    expect(dictionary.entries.some((e) => e.name === 'create_alert_2')).toBe(false);
    for (const entry of dictionary.entries) {
      expect(entry.relations?.some((r) => r.target === 'create_alert_2')).toBeFalsy();
    }
    for (const node of dictionary.index.nodes) expect(node.examples ?? []).not.toContain('create_alert_2');
    expect(validateDictionary(dictionary).errors).toEqual([]);
  });

  it('records itself as a source and leaves the generated dictionary untouched', () => {
    const { dictionary: generated } = generate();
    const before = JSON.stringify(generated);
    const { dictionary } = applyOverlay(generated, overlayDoc());
    expect(JSON.stringify(generated)).toBe(before);
    expect(dictionary.sources?.some((s) => s.type === 'overlay')).toBe(true);
  });

  it('is idempotent: applying the same overlay twice changes nothing more', () => {
    const { dictionary: generated } = generate();
    const once = applyOverlay(generated, overlayDoc()).dictionary;
    const twice = applyOverlay(once, overlayDoc()).dictionary;
    twice.sources = once.sources; // the second run appends its own source line
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('refuses an overlay for another dictionary or in another format', () => {
    const { dictionary } = generate();
    expect(() => applyOverlay(dictionary, { toolDictionaryOverlay: '0.1', dictionaryId: 'other' })).toThrow(OverlayError);
    expect(() => applyOverlay(dictionary, { dictionaryId: 'sample' })).toThrow(OverlayError);
  });

  it('applies the "*" patch to every entry, and lets a named patch override it', () => {
    const { dictionary: generated } = generate();
    const { dictionary, issues } = applyOverlay(generated, {
      toolDictionaryOverlay: '0.1',
      dictionaryId: 'sample',
      entries: {
        '*': { keywords: { add: ['crypto'], remove: ['token'] }, stability: 'beta' },
        token_price: { stability: 'stable' },
      },
    });
    for (const entry of dictionary.entries) {
      expect(`${entry.name}: ${entry.keywords?.includes('crypto')}`).toBe(`${entry.name}: true`);
      expect(`${entry.name}: ${entry.keywords?.includes('token')}`).toBe(`${entry.name}: false`);
    }
    expect(entryOf(dictionary, 'token_price').stability).toBe('stable'); // named patch wins
    expect(entryOf(dictionary, 'wallet_holdings').stability).toBe('beta');
    // The wildcard is not a name, so it must never be reported as a stale key.
    expect(issues).toEqual([]);
    expect(validateDictionary(dictionary).errors).toEqual([]);
  });

  it('adds index nodes and moves entries under them', () => {
    const { dictionary: generated } = generate();
    const { dictionary, issues } = applyOverlay(generated, {
      toolDictionaryOverlay: '0.1',
      dictionaryId: 'sample',
      addIndex: [
        { path: 'tokens/pricing', title: 'Pricing', summary: 'Price of a token.', sampleQueries: ['price of a token'] },
        { path: 'ghost/child', title: 'Ghost', summary: 'Orphan.' },
      ],
      // Patching one field of the old category must not freeze the others: the
      // listings it does not mention are still derived.
      index: { tokens: { summary: 'Everything keyed by a token address.' } },
      entries: { token_price: { path: 'tokens/pricing' } },
    });
    expect(entryOf(dictionary, 'token_price').path).toBe('tokens/pricing');
    expect(issues.some((i) => i.at.includes('addIndex'))).toBe(true);
    expect(validateDictionary(dictionary).errors).toEqual([]);

    // The index listings are derived, so moving an entry has to move it in the
    // index too: the old category must stop advertising it and the new one must
    // start, without the author writing `examples` out by hand.
    const nodes = flattenNodes(dictionary.index.nodes);
    const pricing = nodes.find((n) => n.path === 'tokens/pricing');
    expect(pricing?.examples).toEqual(['token_price']);
    expect(pricing?.sampleQueries).toEqual(['price of a token']); // authored, not re-derived
    expect(nodes.find((n) => n.path === 'tokens')?.examples ?? []).not.toContain('token_price');
  });

  it('re-derives the index listings of a category it emptied', () => {
    const { dictionary: generated } = generate();
    const tokens = flattenNodes(generated.index.nodes).find((n) => n.path === 'tokens');
    expect(tokens?.examples?.length).toBeGreaterThan(0);
    const { dictionary } = applyOverlay(generated, {
      toolDictionaryOverlay: '0.1',
      dictionaryId: 'sample',
      hide: generated.entries.filter((e) => e.path === 'tokens').map((e) => e.name),
    });
    const emptied = flattenNodes(dictionary.index.nodes).find((n) => n.path === 'tokens');
    expect(emptied?.examples).toBeUndefined();
    expect(validateDictionary(dictionary).errors).toEqual([]);
  });
});
