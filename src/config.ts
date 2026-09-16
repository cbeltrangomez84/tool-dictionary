/**
 * Service configuration: a JSON file plus a few environment overrides.
 *
 * Tokens are configuration, never dictionary content (spec 16.4), so any
 * string value may reference an environment variable as `${NAME}`; the file
 * itself can then be committed without secrets.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DictionaryConfig, Limits, ThresholdConfig } from './service';

export interface FileConfig {
  host?: string;
  port?: number;
  logger?: boolean;
  bodyLimitBytes?: number;
  rateLimitPerMinute?: number;
  /** Address clients reach the server at; fills absolute endpoints in the agent bundle (spec 14.4). */
  publicBaseUrl?: string;
  /** Trust proxy headers: `true` or a comma-separated list of proxy addresses / CIDRs. Also `TD_TRUST_PROXY`. */
  trustProxy?: boolean | string;
  limits?: Partial<Limits>;
  threshold?: Partial<ThresholdConfig>;
  adminTokens?: string[];
  dictionaries?: DictionaryConfig[];
}

export interface ResolvedConfig extends FileConfig {
  host: string;
  port: number;
  dictionaries: DictionaryConfig[];
  adminTokens: string[];
}

export class ConfigError extends Error {}

function expandEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const v = env[name];
      if (v === undefined) throw new ConfigError(`environment variable ${name} referenced in config is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v, env)]));
  }
  return value;
}

function assertDictionaryConfig(d: unknown, i: number): asserts d is DictionaryConfig {
  const at = `dictionaries[${i}]`;
  if (!d || typeof d !== 'object') throw new ConfigError(`${at} must be an object`);
  const cfg = d as Record<string, unknown>;
  const source = cfg.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') throw new ConfigError(`${at}.source is required`);
  if (!['url', 'file'].includes(String(source.kind))) throw new ConfigError(`${at}.source.kind must be "url" or "file" (inline dictionaries arrive via PUT)`);
  if (typeof source.location !== 'string' || !source.location) throw new ConfigError(`${at}.source.location is required`);
  if (source.kind === 'url' && !/^https?:\/\//.test(source.location)) throw new ConfigError(`${at}.source.location must be an http(s) URL`);
  for (const key of ['readTokens', 'adminTokens'] as const) {
    if (cfg[key] !== undefined && (!Array.isArray(cfg[key]) || !(cfg[key] as unknown[]).every((t) => typeof t === 'string' && t.length > 0))) {
      throw new ConfigError(`${at}.${key} must be an array of non-empty strings`);
    }
  }
}

export async function loadConfig(file: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedConfig> {
  let fromFile: FileConfig = {};
  if (file) {
    const text = await readFile(file, 'utf8');
    fromFile = expandEnv(JSON.parse(text), env) as FileConfig;
    const dir = path.dirname(path.resolve(file));
    // File sources are relative to the config file, not the working directory.
    for (const d of fromFile.dictionaries ?? []) {
      if (d.source?.kind === 'file' && d.source.location && !path.isAbsolute(d.source.location)) {
        d.source.location = path.resolve(dir, d.source.location);
      }
    }
  }
  const dictionaries = fromFile.dictionaries ?? [];
  dictionaries.forEach((d, i) => assertDictionaryConfig(d, i));

  const adminTokens = [...(fromFile.adminTokens ?? []), ...(env.TD_ADMIN_TOKENS ? env.TD_ADMIN_TOKENS.split(',').map((t) => t.trim()).filter(Boolean) : [])];
  const port = env.TD_PORT ? Number(env.TD_PORT) : (fromFile.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`invalid port ${String(port)}`);

  const publicBaseUrl = env.TD_PUBLIC_BASE_URL ?? fromFile.publicBaseUrl;
  if (publicBaseUrl !== undefined && !/^https?:\/\/[^\s?#]+$/.test(publicBaseUrl)) {
    throw new ConfigError(`invalid publicBaseUrl ${JSON.stringify(publicBaseUrl)}: expected an http(s) origin, optionally with a path prefix`);
  }

  const trustProxy = parseTrustProxy(env.TD_TRUST_PROXY ?? fromFile.trustProxy);

  return {
    ...fromFile,
    host: env.TD_HOST ?? fromFile.host ?? '127.0.0.1',
    port,
    adminTokens,
    dictionaries,
    ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
    ...(trustProxy !== undefined ? { trustProxy } : {}),
  };
}

/**
 * `true`/`false` or a non-empty address list. The env form is a string, so
 * "true" and "10.0.0.0/8, 127.0.0.1" are both accepted; anything else is a
 * configuration error rather than a silent `false` that leaves the rate
 * limiter keyed on the proxy.
 */
function parseTrustProxy(value: unknown): boolean | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text.length > 0 && !/^\d+$/.test(text)) return text;
  }
  throw new ConfigError(`invalid trustProxy ${JSON.stringify(value)}: expected true, false, or a comma-separated list of proxy addresses / CIDRs`);
}
