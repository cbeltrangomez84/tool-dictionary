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
