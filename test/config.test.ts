import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

async function configFile(body: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'td-config-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(body));
  return file;
}

describe('config: publicBaseUrl', () => {
  it('is absent by default, read from the file, and overridden by TD_PUBLIC_BASE_URL', async () => {
    const env = { TD_ADMIN_TOKENS: 'root' };
    expect((await loadConfig(undefined, env)).publicBaseUrl).toBeUndefined();
    const file = await configFile({ publicBaseUrl: 'https://dict.example.com/prefix', adminTokens: ['root'] });
    expect((await loadConfig(file, {})).publicBaseUrl).toBe('https://dict.example.com/prefix');
    expect((await loadConfig(file, { TD_PUBLIC_BASE_URL: 'http://localhost:8080' })).publicBaseUrl).toBe('http://localhost:8080');
  });

  it('rejects a value that is not an http(s) origin', async () => {
    await expect(loadConfig(undefined, { TD_ADMIN_TOKENS: 'root', TD_PUBLIC_BASE_URL: 'dict.example.com' })).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(undefined, { TD_ADMIN_TOKENS: 'root', TD_PUBLIC_BASE_URL: 'https://dict.example.com/?x=1' })).rejects.toThrow(/publicBaseUrl/);
  });
});

describe('config: trustProxy', () => {
  it('accepts the file value and the string forms of TD_TRUST_PROXY', async () => {
    const env = { TD_ADMIN_TOKENS: 'root' };
    expect((await loadConfig(undefined, env)).trustProxy).toBeUndefined();
    const file = await configFile({ trustProxy: true, adminTokens: ['root'] });
    expect((await loadConfig(file, {})).trustProxy).toBe(true);
    expect((await loadConfig(file, { TD_TRUST_PROXY: 'false' })).trustProxy).toBe(false);
    expect((await loadConfig(file, { TD_TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' })).trustProxy).toBe('10.0.0.0/8, 127.0.0.1');
  });

  it('rejects a hop count and an empty list', async () => {
    const file = await configFile({ trustProxy: 2, adminTokens: ['root'] });
    await expect(loadConfig(file, {})).rejects.toThrow(/trustProxy/);
    await expect(loadConfig(undefined, { TD_ADMIN_TOKENS: 'root', TD_TRUST_PROXY: '1' })).rejects.toThrow(/trustProxy/);
    await expect(loadConfig(undefined, { TD_ADMIN_TOKENS: 'root', TD_TRUST_PROXY: '  ' })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('config: execution (spec 9.7)', () => {
  it('is absent unless configured, and TD_EXECUTE flips enabled', async () => {
    expect((await loadConfig(undefined, { TD_ADMIN_TOKENS: 'root' })).execution).toBeUndefined();
    expect((await loadConfig(undefined, { TD_ADMIN_TOKENS: 'root', TD_EXECUTE: 'true' })).execution).toEqual({ enabled: true });
    const file = await configFile({ adminTokens: ['root'], execution: { enabled: true, maxTimeoutMs: 5000, variables: { REGION: '${REGION}' } } });
    expect((await loadConfig(file, { REGION: 'eu' })).execution).toEqual({ enabled: true, maxTimeoutMs: 5000, variables: { REGION: 'eu' } });
    expect((await loadConfig(file, { REGION: 'eu', TD_EXECUTE: 'false' })).execution).toMatchObject({ enabled: false });
  });

  it('rejects malformed execution settings at start', async () => {
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { enabled: 'yes' } }), {})).rejects.toThrow(/execution.enabled/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { maxTimeoutMs: 0 } }), {})).rejects.toThrow(/maxTimeoutMs/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { variables: { lower: 'x' } } }), {})).rejects.toThrow(/variable name/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { variables: { HOST: 1 } } }), {})).rejects.toThrow(/must be a string/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { timeout: 1 } }), {})).rejects.toThrow(/unknown keys/);
    await expect(loadConfig(undefined, { TD_ADMIN_TOKENS: 'root', TD_EXECUTE: 'on' })).rejects.toThrow(/TD_EXECUTE/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], dictionaries: [{ source: { kind: 'file', location: 'x.json' }, execute: 'no' }] }), {})).rejects.toThrow(/execute must be a boolean/);
  });

  it('meteringHeaders: lower-cased and de-duplicated; not an array, not a header name, or a header the service owns fails at start', async () => {
    const file = await configFile({ adminTokens: ['root'], execution: { meteringHeaders: ['X-Credits-Used', 'x-credits-used', 'x-units'] } });
    expect((await loadConfig(file, {})).execution).toEqual({ meteringHeaders: ['x-credits-used', 'x-units'] });
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { meteringHeaders: 'x-credits-used' } }), {})).rejects.toThrow(/array of header names/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { meteringHeaders: ['x credits'] } }), {})).rejects.toThrow(/not a header name/);
    await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { meteringHeaders: [7] } }), {})).rejects.toThrow(/not a header name/);
    for (const owned of ['Content-Length', 'content-type', 'cache-control', 'etag', 'retry-after', 'x-upstream-status', 'x-budget-used-bytes', 'access-control-allow-origin', 'set-cookie']) {
      await expect(loadConfig(await configFile({ adminTokens: ['root'], execution: { meteringHeaders: [owned] } }), {})).rejects.toThrow(/sets itself/);
    }
  });
});
