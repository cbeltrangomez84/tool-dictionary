import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server';
import { DictionaryService, ServiceError } from '../src/service';
import { declaredOrigins, renderExecuteText } from '../src/execute';
import { example, nftDictionary } from './helpers';

/** A fetch double: records every upstream call, answers from a script, never touches the network. */
function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  let next: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return next(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls, answer: (fn: typeof next) => (next = fn) };
}

const KEY = 'test-key-abcdef123456';

describe('execute (spec 9.7)', () => {
  const upstream = fakeFetch();
  let app: FastifyInstance;
  let service: DictionaryService;

  beforeAll(async () => {
    service = new DictionaryService({ execution: { enabled: true, maxTimeoutMs: 200, defaultTimeoutMs: 100, maxResponseBytes: 512 }, fetch: upstream.impl, globalAdminTokens: ['root'] });
    await service.install({ source: { kind: 'inline' } }, example());
    await service.install({ source: { kind: 'inline' }, execute: false }, nftDictionary());
    app = buildServer({ service, rateLimitPerMinute: 0 });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await service.close();
  });

  it('renders the descriptor, forwards the caller credential, applies schema defaults, and returns the parsed body', async () => {
    upstream.calls.length = 0;
    upstream.answer(() => new Response(JSON.stringify({ count: 1234 }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dictionaries/crypto-data/execute',
      headers: { 'x-api-key': KEY },
      payload: { name: 'holders_count', params: { address: 'So111', excludeContracts: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-upstream-status']).toBe('200');
    expect(res.headers['x-budget-used-bytes']).toBe(String(Buffer.byteLength(res.body)));
    const body = res.json();
    expect(body).toMatchObject({
      kind: 'result',
      dictionary: { id: 'crypto-data', version: 47 },
      tool: 'holders_count',
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { count: 1234 },
      bodyFormat: 'json',
      truncated: false,
      budget: { truncated: false },
    });
    expect(typeof body.elapsedMs).toBe('number');
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    // Path param encoded, query from the descriptor, schema default `chain=solana` applied.
    expect(call.url).toBe('https://data.example.com/v1/tokens/So111/holders/count?chain=solana&exclude_contracts=true');
    expect(call.init.method).toBe('GET');
    expect((call.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(call.init.redirect).toBe('manual');
    // The credential is not echoed anywhere in the response.
    expect(res.body).not.toContain(KEY);
  });

  it('accepts the credential as x-td-var-<NAME> and strips a literal prefix the descriptor adds', async () => {
    upstream.calls.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dictionaries/crypto-data/execute',
      headers: { 'x-td-var-crypto_data_api_key': KEY },
      payload: { name: 'token_price', params: { address: 'abc' } },
    });
    expect(res.statusCode).toBe(200);
    expect((upstream.calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('answers 401 missing_credential naming the header, without calling upstream', async () => {
    upstream.calls.length = 0;
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', payload: { name: 'holders_count', params: { address: 'So111' } } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'missing_credential', details: [{ variable: 'CRYPTO_DATA_API_KEY', headers: ['x-api-key', 'x-td-var-crypto_data_api_key'] }] });
    expect(upstream.calls).toHaveLength(0);
  });

  it('validates params against the input schema with a clear 400', async () => {
    upstream.calls.length = 0;
    const missing = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'holders_count', params: {} } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'invalid_params', details: [{ at: 'params', keyword: 'required' }] });

    const wrongType = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'holders_count', params: { address: 'x', chain: 'mars' } } });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().error.details[0]).toMatchObject({ at: 'params/chain', keyword: 'enum' });

    const notObject = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'holders_count', params: [1] } });
    expect(notObject.statusCode).toBe(400);

    const noName = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { params: {} } });
    expect(noName.statusCode).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('only catalogue entries execute: unknown names are 404 and a URL in the body is ignored', async () => {
    upstream.calls.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dictionaries/crypto-data/execute',
      headers: { 'x-api-key': KEY },
      payload: { name: 'fetch_anything', params: { url: 'https://evil.example.com' }, url: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('entry_not_found');
    expect(upstream.calls).toHaveLength(0);
  });

  it('is 403 execution_disabled for a dictionary that opted out, and for a deployment with execution off', async () => {
    const optedOut = await app.inject({ method: 'POST', url: '/v1/dictionaries/nft-data/execute', payload: { name: 'collection_floor', params: { collection: 'x' } } });
    expect(optedOut.statusCode).toBe(403);
    expect(optedOut.json().error.code).toBe('execution_disabled');

    const off = new DictionaryService({ fetch: upstream.impl });
    await off.install({ source: { kind: 'inline' } }, example());
    await expect(off.execute('crypto-data', { name: 'holders_count', params: { address: 'x' } }, { 'x-api-key': KEY })).rejects.toMatchObject({ status: 403, code: 'execution_disabled' });
    expect(off.executable('crypto-data')).toBe(false);
    await off.close();
  });

  it('does not follow redirects and reports them as 502 upstream_redirect', async () => {
    upstream.answer(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/x' } }));
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'upstream_redirect', details: [{ status: 302 }] });
    expect(res.body).not.toContain('elsewhere');
  });

  it('times out at the capped per-request deadline with 504 upstream_timeout', async () => {
    upstream.answer((_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const started = Date.now();
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(res.statusCode).toBe(504);
    // The example's timeoutHintMs is 3000; the deployment caps at 200.
    expect(res.json().error).toMatchObject({ code: 'upstream_timeout', details: [{ timeoutMs: 200 }] });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reports network failures as 502 upstream_error with the credential redacted', async () => {
    upstream.answer(() => {
      throw new TypeError(`fetch failed: ${KEY} rejected`);
    });
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('upstream_error');
    expect(res.body).not.toContain(KEY);
    expect(res.body).toContain('[redacted]');
  });

  it('passes upstream 4xx/5xx through as a result, not as a service error', async () => {
    upstream.answer(() => new Response(JSON.stringify({ error: 'no such token' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream-status']).toBe('404');
    expect(res.json()).toMatchObject({ kind: 'result', status: 404, body: { error: 'no such token' } });
  });

  it('cuts the upstream read at maxResponseBytes and aborts the rest', async () => {
    let aborted = false;
    upstream.answer((_url, init) => {
      init.signal!.addEventListener('abort', () => (aborted = true));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' }, maxBytes: 65_536 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bytes).toBe(512);
    expect(body.truncated).toBe(true);
    expect(body.bodyFormat).toBe('text');
    expect((body.body as string).length).toBe(512);
    expect(aborted).toBe(true);
  });

  it('honours the response budget exactly: a big JSON body comes back as text cut to fit', async () => {
    // A deployment with the default 1 MiB read cap, so only the response budget is in play.
    const roomy = new DictionaryService({ execution: { enabled: true }, fetch: upstream.impl });
    await roomy.install({ source: { kind: 'inline' } }, example());
    const wide = buildServer({ service: roomy, rateLimitPerMinute: 0 });
    await wide.ready();
    const big = { rows: Array.from({ length: 30 }, (_, i) => ({ i, text: 'ünïcödé '.repeat(2) })) };
    upstream.answer(() => new Response(JSON.stringify(big), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await wide.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' }, maxBytes: 1024 } });
    expect(res.statusCode).toBe(200);
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(1024);
    expect(res.headers['x-budget-truncated']).toBe('true');
    const body = res.json();
    expect(body.bodyFormat).toBe('text');
    expect(body.truncated).toBe(true);
    expect(body.budget).toMatchObject({ maxBytes: 1024, truncated: true, usedBytes: Buffer.byteLength(res.body) });
    expect(body.body.endsWith('…')).toBe(true);
    // The upstream itself was read in full; only the returned body was cut.
    expect(body.bytes).toBe(Buffer.byteLength(JSON.stringify(big)));
    await wide.close();
    await roomy.close();
  });

  it('format=text renders one header line and the body', async () => {
    upstream.answer(() => new Response(JSON.stringify({ price: 1.5 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute?format=text', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body.split('\n')[0]).toMatch(/^token_price → 200 application\/json \(\d+ bytes\)$/);
    expect(res.body).toContain('"price": 1.5');
    const viaBody = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' }, format: 'text' } });
    expect(viaBody.headers['content-type']).toMatch(/text\/plain/);
  });

  it('accepts the agent-chat envelope: args under "input"', async () => {
    upstream.calls.length = 0;
    upstream.answer(() => new Response('{"count":7}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dictionaries/crypto-data/execute',
      headers: { 'x-api-key': KEY },
      payload: { tool: 'execute_tool', input: { name: 'holders_count', params: { address: 'So111' } }, chatId: 'c1', callId: 'k1', chatObject: { any: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tool: 'holders_count', body: { count: 7 } });
    expect(upstream.calls[0]!.url).toContain('/v1/tokens/So111/holders/count');
  });

  it('rejects a "dictionary" that disagrees with the path, accepts one that agrees', async () => {
    const mismatch = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' }, dictionary: 'nft-data' } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toMatchObject({ code: 'dictionary_mismatch', details: [{ dictionary: 'crypto-data' }] });
    upstream.answer(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const same = await app.inject({ method: 'POST', url: '/v1/dictionaries/crypto-data/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' }, dictionary: 'crypto-data' } });
    expect(same.statusCode).toBe(200);
  });

  it('service-level /v1/execute needs "dictionary" when several are visible, and lists them', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'dictionary_required', details: [{ dictionaries: ['crypto-data', 'nft-data'] }] });

    upstream.answer(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const named = await app.inject({ method: 'POST', url: '/v1/execute', headers: { 'x-api-key': KEY }, payload: { tool: 'execute_tool', input: { name: 'token_price', params: { address: 'abc' }, dictionary: 'crypto-data' } } });
    expect(named.statusCode).toBe(200);
    expect(named.json().dictionary.id).toBe('crypto-data');

    const unknown = await app.inject({ method: 'POST', url: '/v1/execute', payload: { name: 'x', params: {}, dictionary: 'nope' } });
    expect(unknown.statusCode).toBe(404);
  });

  it('service-level routes pick the only dictionary when exactly one is visible', async () => {
    const single = new DictionaryService({ execution: { enabled: true }, fetch: upstream.impl });
    await single.install({ source: { kind: 'inline' } }, example());
    const one = buildServer({ service: single, rateLimitPerMinute: 0 });
    await one.ready();
    upstream.answer(() => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const exec = await one.inject({ method: 'POST', url: '/v1/execute', headers: { 'x-api-key': KEY }, payload: { name: 'token_price', params: { address: 'abc' } } });
    expect(exec.statusCode).toBe(200);
    const search = await one.inject({ method: 'POST', url: '/v1/search', payload: { tool: 'search_tools', input: { query: 'holders' } } });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ kind: 'results', dictionary: { id: 'crypto-data' } });
    const getSearch = await one.inject({ method: 'GET', url: '/v1/search?q=holders&format=text' });
    expect(getSearch.statusCode).toBe(200);
    const entries = await one.inject({ method: 'GET', url: '/v1/entries?format=text' });
    expect(entries.statusCode).toBe(200);
    const tool = await one.inject({ method: 'GET', url: '/v1/tool', headers: { host: 'dict.example.com' } });
    expect(tool.statusCode).toBe(200);
    expect(tool.json().tools.map((t: { name: string }) => t.name)).toEqual(['search_tools', 'list_tools', 'execute_tool']);
    expect(tool.json().execute).toBe(true);

    await one.close();
    await single.close();
  });

  it('bundle and list advertise execution per dictionary', async () => {
    const bundle = await app.inject({ method: 'GET', url: '/v1/dictionaries/crypto-data/tool', headers: { host: 'dict.example.com' } });
    expect(bundle.json().tools[2]).toMatchObject({ name: 'execute_tool', method: 'POST', endpoint: 'http://dict.example.com/v1/dictionaries/crypto-data/execute' });
    expect(bundle.json().systemPrompt).toContain('execute_tool');
    const optedOut = await app.inject({ method: 'GET', url: '/v1/dictionaries/nft-data/tool' });
    expect(optedOut.json().tools.map((t: { name: string }) => t.name)).toEqual(['search_tools', 'list_tools']);
    expect(optedOut.json().execute).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/v1/dictionaries', headers: { host: 'dict.example.com' } });
    const byId = Object.fromEntries(list.json().dictionaries.map((d: { id: string }) => [d.id, d]));
    expect(byId['crypto-data']).toMatchObject({ execute: true, endpoints: { execute: 'http://dict.example.com/v1/dictionaries/crypto-data/execute' } });
    expect(byId['nft-data'].execute).toBe(false);
    expect(byId['nft-data'].endpoints.execute).toBeUndefined();

    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.json().execution).toEqual({ enabled: true, maxTimeoutMs: 200, defaultTimeoutMs: 100, maxResponseBytes: 512, variables: [] });
  });

  it('refuses a target the dictionary did not declare: a caller-chosen host never executes', async () => {
    upstream.calls.length = 0;
    const doc = nftDictionary({ id: 'mixed', defaults: { baseUrl: 'https://nft.example.com', variables: { HOST: { description: 'Upstream host.' } } } });
    doc.entries.push(
      // Host comes from a deployment variable: declared, allowed.
      { ...doc.entries[0]!, name: 'via_variable', call: { type: 'http', method: 'GET', baseUrl: 'https://{{HOST}}', urlTemplate: '/x' } },
      // Host comes from an input: it declares no origin of its own, so only a host the
      // dictionary declares elsewhere can ever be reached through it.
      {
        ...doc.entries[0]!,
        name: 'via_param',
        input: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
        call: { type: 'http', method: 'GET', baseUrl: 'https://{host}', urlTemplate: '/x' },
      },
    );
    const svc = new DictionaryService({ execution: { enabled: true, variables: { HOST: 'other.example.com' } }, fetch: upstream.impl });
    await svc.install({ source: { kind: 'inline' } }, doc);
    expect(declaredOrigins(doc, { HOST: 'other.example.com' })).toEqual(new Set(['https://nft.example.com', 'https://other.example.com']));

    upstream.answer(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(svc.execute('mixed', { name: 'via_variable', params: { collection: 'c' } }, {})).resolves.toMatchObject({ status: 200 });
    expect(upstream.calls[0]!.url).toBe('https://other.example.com/x');

    await expect(svc.execute('mixed', { name: 'via_param', params: { host: 'nft.example.com' } }, {})).resolves.toMatchObject({ status: 200 });
    await expect(svc.execute('mixed', { name: 'via_param', params: { host: 'attacker.example.com' } }, {})).rejects.toMatchObject({ status: 502, code: 'target_not_allowed', details: [{ origin: 'https://attacker.example.com' }] });
    // Inputs are URL-encoded into the template, so a port or a path in the value cannot reshape the URL; it just fails to parse.
    await expect(svc.execute('mixed', { name: 'via_param', params: { host: 'nft.example.com:8443' } }, {})).rejects.toMatchObject({ status: 400, code: 'invalid_params' });
    expect(upstream.calls).toHaveLength(2);
    await svc.close();
  });

  it('non-http entries are 422 not_executable and unknown deployment variables are 500 missing_variable', async () => {
    const doc = nftDictionary({ id: 'kinds', defaults: { baseUrl: 'https://nft.example.com', variables: { REGION: { description: 'Region slug.' } } } });
    doc.entries.push(
      { ...doc.entries[0]!, name: 'local_thing', call: { type: 'local', handler: 'x' } as never },
      { ...doc.entries[0]!, name: 'needs_var', call: { type: 'http', method: 'GET', baseUrl: 'https://nft.example.com', urlTemplate: '/{{REGION}}/x' } },
    );
    const svc = new DictionaryService({ execution: { enabled: true }, fetch: upstream.impl });
    await svc.install({ source: { kind: 'inline' } }, doc);
    await expect(svc.execute('kinds', { name: 'local_thing', params: { collection: 'x' } }, {})).rejects.toMatchObject({ status: 422, code: 'not_executable' });
    await expect(svc.execute('kinds', { name: 'needs_var', params: { collection: 'x' } }, {})).rejects.toMatchObject({ status: 500, code: 'missing_variable', details: [{ variable: 'REGION' }] });
    await svc.close();
  });

  it('renderExecuteText marks truncation in the header line', () => {
    const text = renderExecuteText({
      kind: 'result',
      dictionary: { id: 'd', version: 1, etag: 'e' },
      tool: 't',
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: 'abc…',
      bodyFormat: 'text',
      bytes: 999,
      truncated: true,
      elapsedMs: 1,
      budget: { maxBytes: 1024, usedBytes: 100, truncated: true },
    });
    expect(text).toBe('t → 200 text/plain (999 bytes, truncated)\nabc…');
  });

  it('ServiceError carries the execute codes', () => {
    expect(new ServiceError(403, 'execution_disabled', 'x').code).toBe('execution_disabled');
  });
});
