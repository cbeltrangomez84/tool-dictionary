import { describe, expect, it } from 'vitest';
import { resolveCall, ResolveError } from '../src/resolve';
import type { Dictionary, Entry, HttpCall } from '../src/types';
import { validateDictionary } from '../src/validate';
import { example } from './helpers';

const KEY = 'sk_test_0123456789abcdef0123456789';
const entryOf = (dict: Dictionary, name: string): Entry => dict.entries.find((e) => e.name === name)!;

describe('resolveCall', () => {
  it('builds the request from defaults, inputs and the executor-held variable', () => {
    const dict = example();
    const request = resolveCall(entryOf(dict, 'holders_count'), dict, {
      input: { address: 'So11111111111111111111111111111111111111112', chain: 'solana' },
      variables: { CRYPTO_DATA_API_KEY: KEY },
    });
    expect(request).toEqual({
      method: 'GET',
      url: 'https://data.example.com/v1/tokens/So11111111111111111111111111111111111111112/holders/count?chain=solana',
      headers: { 'x-api-key': KEY },
    });
  });

  it('drops an optional input that was not supplied instead of sending an empty value', () => {
    const dict = example();
    const request = resolveCall(entryOf(dict, 'holders_count'), dict, {
      input: { address: 'abc', chain: 'solana', excludeContracts: true },
      variables: { CRYPTO_DATA_API_KEY: KEY },
    });
    expect(request.url).toBe('https://data.example.com/v1/tokens/abc/holders/count?chain=solana&exclude_contracts=true');
  });

  it('names what is missing', () => {
    const dict = example();
    expect(() => resolveCall(entryOf(dict, 'holders_count'), dict, { input: { chain: 'solana' }, variables: { CRYPTO_DATA_API_KEY: KEY } })).toThrow(
      'input "address" was not supplied',
    );
    try {
      resolveCall(entryOf(dict, 'holders_count'), dict, { input: { address: 'abc' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ResolveError);
      expect((error as ResolveError).missing).toEqual({ kind: 'variable', name: 'CRYPTO_DATA_API_KEY' });
    }
  });

  it('percent-encodes path inputs and leaves an input containing braces alone', () => {
    const dict = example();
    const request = resolveCall(entryOf(dict, 'holders_count'), dict, {
      input: { address: 'a/b {{CRYPTO_DATA_API_KEY}} {chain}', chain: 'solana' },
      variables: { CRYPTO_DATA_API_KEY: KEY },
    });
    expect(request.url).toBe('https://data.example.com/v1/tokens/a%2Fb%20%7B%7BCRYPTO_DATA_API_KEY%7D%7D%20%7Bchain%7D/holders/count?chain=solana');
    expect(request.url).not.toContain(KEY);
  });

  it('honors a per-entry override of the default credential, a query placement and a scheme prefix', () => {
    const dict = example();
    const open = entryOf(dict, 'holders_count');
    open.call.auth = { kind: 'none' };
    expect(resolveCall(open, dict, { input: { address: 'abc' } }).headers).toEqual({});

    const query = entryOf(dict, 'token_price');
    query.call.auth = { kind: 'caller', in: 'query', name: 'key', value: '{{CRYPTO_DATA_API_KEY}}' };
    expect(resolveCall(query, dict, { input: { address: 'abc', chain: 'solana' }, variables: { CRYPTO_DATA_API_KEY: KEY } }).url).toBe(
      `https://data.example.com/v1/tokens/abc/price?chain=solana&key=${KEY}`,
    );

    const bearer = entryOf(dict, 'token_market_cap');
    bearer.call.auth = { kind: 'caller', in: 'header', name: 'Authorization', value: 'Bearer {{CRYPTO_DATA_API_KEY}}' };
    expect(resolveCall(bearer, dict, { input: { address: 'abc', chain: 'solana' }, variables: { CRYPTO_DATA_API_KEY: KEY } }).headers).toEqual({
      Authorization: `Bearer ${KEY}`,
    });
    expect(validateDictionary(dict).errors).toEqual([]);
  });

  it('substitutes non-secret variables in the base URL and merged headers', () => {
    const dict = example();
    dict.defaults!.variables!.REGION = { description: 'Deployment region.' };
    dict.defaults!.baseUrl = 'https://{{REGION}}.data.example.com';
    dict.defaults!.headers = { 'x-region': '{{REGION}}', 'x-trace': 'dictionary' };
    const entry = entryOf(dict, 'holders_count');
    (entry.call as HttpCall).headers = { 'x-trace': 'entry' };
    expect(validateDictionary(dict).errors).toEqual([]);
    const request = resolveCall(entry, dict, { input: { address: 'abc' }, variables: { CRYPTO_DATA_API_KEY: KEY, REGION: 'eu' } });
    expect(request.url).toBe('https://eu.data.example.com/v1/tokens/abc/holders/count');
    expect(request.headers).toEqual({ 'x-region': 'eu', 'x-trace': 'entry', 'x-api-key': KEY });
  });

  it('fills a body template, keeping the type of a leaf that is exactly one placeholder', () => {
    const dict = example();
    const entry = entryOf(dict, 'holders_count');
    entry.input = { type: 'object', properties: { address: { type: 'string' }, limit: { type: 'integer' }, tags: { type: 'array' } }, required: ['address'] };
    entry.call = {
      type: 'http',
      method: 'POST',
      urlTemplate: '/v1/query',
      bodyTemplate: { token: '{address}', limit: '{limit}', tags: '{tags}', label: 'token {address}' },
    };
    const request = resolveCall(entry, dict, { input: { address: 'abc', limit: 5, tags: ['a', 'b'] }, variables: { CRYPTO_DATA_API_KEY: KEY } });
    expect(request.body).toEqual({ token: 'abc', limit: 5, tags: ['a', 'b'], label: 'token abc' });

    entry.call.bodyTemplate = null;
    expect(resolveCall(entry, dict, { input: { address: 'abc' }, variables: { CRYPTO_DATA_API_KEY: KEY } }).body).toEqual({ address: 'abc' });
  });

  it('refuses a non-http call', () => {
    const dict = example();
    const entry = entryOf(dict, 'holders_count');
    entry.call = { type: 'mcp', server: 'data', tool: 'holders' };
    expect(() => resolveCall(entry, dict)).toThrow(/mcp call, not http/);
  });
});
