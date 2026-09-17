/**
 * Catalogue execution (spec 0.2, §9.7 and §16.1): the service runs an entry
 * from its own dictionary on the caller's behalf. Everything that reaches the
 * network is decided by the dictionary and the deployment — method, host,
 * path, headers — never by the request. The request contributes the tool
 * name, the validated inputs, and the credential the entry declares as
 * caller-held, which is copied through and never stored, logged, or echoed.
 *
 * Off unless a deployment turns it on: a dictionary is safe to publish because
 * it only describes an API, and an executing service is a different thing.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ServiceError } from './errors';
import { effectiveCall } from './load';
import { resolveCall, ResolveError, type ResolvedRequest } from './resolve';
import type { Dictionary, DictionaryStamp, Entry } from './types';
import { AUTH_VALUE } from './validate';

export interface ExecutionConfig {
  /** Execution is opt-in per deployment. */
  enabled: boolean;
  /** Ceiling for any single upstream call; an entry's `timeoutHintMs` is capped by it. */
  maxTimeoutMs: number;
  /** Used when the entry declares no `timeoutHintMs`. */
  defaultTimeoutMs: number;
  /** Upstream bytes read before the body is cut, independent of the response budget. */
  maxResponseBytes: number;
  /**
   * Values for non-secret `{{VARIABLE}}` references (a region, a tenant slug).
   * Credentials never belong here: the caller-held variable behind `auth.value`
   * always comes from the request.
   */
  variables: Record<string, string>;
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  enabled: false,
  maxTimeoutMs: 25_000,
  defaultTimeoutMs: 10_000,
  maxResponseBytes: 1_048_576,
  variables: {},
};

export interface ExecuteRequest {
  name: string;
  params: Record<string, unknown>;
  /** Response budget for the returned body, clamped by the service limits. */
  maxBytes?: number;
  format?: 'json' | 'text';
}

/** Headers of the incoming request, lower-cased. Only the credential header the entry names is read. */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

export interface ExecuteResponse {
  kind: 'result';
  dictionary: DictionaryStamp;
  tool: string;
  /** Upstream HTTP status. */
  status: number;
  contentType: string | null;
  /** Parsed JSON when the upstream said so and the whole body fit; otherwise text. */
  body: unknown;
  bodyFormat: 'json' | 'text';
  /** Upstream bytes received (after the read cap). */
  bytes: number;
  /** True when the returned body is shorter than what the upstream sent. */
  truncated: boolean;
  elapsedMs: number;
  budget: { maxBytes: number; usedBytes: number; truncated: boolean };
}

/** Fixed envelope cost when the body is a truncated string, so the budget is honoured exactly. */
const TRUNCATION_MARK = '…';

interface Credential {
  variable: string;
  value: string;
  /** Where the caller was expected to put it, for the error that names it. */
  header: string;
}

export class Executor {
  /** `useDefaults` fills schema defaults into the params, so `chain: "solana"` reaches the upstream when the model left it out. */
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true });
  private readonly validators = new WeakMap<Entry, ValidateFunction>();
  private readonly origins = new WeakMap<Dictionary, Set<string>>();
  readonly config: ExecutionConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Partial<ExecutionConfig> = {}, fetchImpl: typeof fetch = fetch) {
    this.config = { ...DEFAULT_EXECUTION, ...config, variables: { ...(config.variables ?? {}) } };
    addFormats(this.ajv);
    this.fetchImpl = fetchImpl;
  }

  /**
   * Run `entry` from `dictionary`. `headers` are the incoming request's; only
   * the credential header the entry declares is read from them.
   */
  async execute(
    dictionary: Dictionary,
    stamp: DictionaryStamp,
    entry: Entry,
    request: ExecuteRequest,
    headers: IncomingHeaders,
    budget: { maxBytes: number },
  ): Promise<ExecuteResponse> {
    const call = effectiveCall(entry, dictionary);
    if (call.type !== 'http') {
      throw new ServiceError(422, 'not_executable', `"${entry.name}" is a ${call.type} tool; this service executes http tools only`);
    }
    const params = this.validateParams(entry, request.params);

    const credential = this.credentialFor(entry, dictionary, headers);
    const variables = { ...this.config.variables };
    if (credential) variables[credential.variable] = credential.value;

    let resolved: ResolvedRequest;
    try {
      resolved = resolveCall(entry, dictionary, { input: params, variables });
    } catch (error) {
      if (error instanceof ResolveError && error.missing?.kind === 'variable') {
        throw new ServiceError(500, 'missing_variable', `"${entry.name}" needs {{${error.missing.name}}}, which this deployment does not configure`, [{ variable: error.missing.name }]);
      }
      if (error instanceof ResolveError && error.missing?.kind === 'param') {
        throw new ServiceError(400, 'invalid_params', error.message, [{ param: error.missing.name }]);
      }
      // Anything else the resolver refuses is the inputs producing an unusable request (e.g. a URL that does not parse).
      if (error instanceof ResolveError) throw new ServiceError(400, 'invalid_params', error.message, []);
      throw error;
    }
    this.assertAllowedTarget(dictionary, entry, resolved.url);

    const timeoutMs = Math.min(call.timeoutHintMs ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs);
    const secrets = credential ? [credential.value] : [];
    const started = Date.now();
    const upstream = await this.fetchUpstream(entry, resolved, timeoutMs, secrets);
    const elapsedMs = Date.now() - started;

    return shape(stamp, entry, upstream, elapsedMs, budget.maxBytes, secrets);
  }

  // -------------------------------------------------------------------------

  /** Returns a copy of `params` with schema defaults filled in; the caller's object is not touched. */
  private validateParams(entry: Entry, raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ServiceError(400, 'invalid_params', '"params" must be an object', []);
    }
    const params = structuredClone(raw) as Record<string, unknown>;
    let validate = this.validators.get(entry);
    if (!validate) {
      validate = this.ajv.compile(entry.input);
      this.validators.set(entry, validate);
    }
    if (!validate(params)) {
      const details = (validate.errors ?? []).map((e) => ({ at: `params${e.instancePath}`, message: e.message ?? 'invalid', keyword: e.keyword }));
      throw new ServiceError(400, 'invalid_params', `params do not match the input schema of "${entry.name}"`, details);
    }
    return params;
  }

  /**
   * The credential behind `auth.value`, read from the incoming request. Two
   * places are accepted: the header the descriptor itself names (natural
   * pass-through), and `x-td-var-<name>` for a descriptor that puts the
   * credential in the query string.
   */
  private credentialFor(entry: Entry, dictionary: Dictionary, headers: IncomingHeaders): Credential | null {
    const call = effectiveCall(entry, dictionary);
    if (call.type !== 'http') return null;
    const auth = call.auth;
    if (!auth || auth.kind !== 'caller' || !auth.in || !auth.name || !auth.value) return null;
    const match = AUTH_VALUE.exec(auth.value);
    if (!match) return null;
    const variable = match[1]!;
    const prefix = auth.value.slice(0, auth.value.indexOf('{{'));

    const generic = `x-td-var-${variable.toLowerCase()}`;
    const named = auth.in === 'header' ? auth.name.toLowerCase() : null;
    const raw = first(headers[generic]) ?? (named ? first(headers[named]) : undefined);
    if (raw === undefined || raw === '') {
      const expected = named ? [named, generic] : [generic];
      throw new ServiceError(401, 'missing_credential', `"${entry.name}" needs the caller's credential; send it as header ${expected.map((h) => `"${h}"`).join(' or ')}`, [
        { variable, headers: expected },
      ]);
    }
    // A caller that passes the full header value ("Bearer xyz") is not doubled up.
    const value = prefix && raw.toLowerCase().startsWith(prefix.toLowerCase()) ? raw.slice(prefix.length) : raw;
    return { variable, value, header: named ?? generic };
  }

  /** The resolved URL must sit on a host the dictionary itself declares (spec 16.1). */
  private assertAllowedTarget(dictionary: Dictionary, entry: Entry, url: string): void {
    let allowed = this.origins.get(dictionary);
    if (!allowed) {
      allowed = declaredOrigins(dictionary, this.config.variables);
      this.origins.set(dictionary, allowed);
    }
    const origin = new URL(url).origin;
    if (!allowed.has(origin)) {
      throw new ServiceError(502, 'target_not_allowed', `"${entry.name}" resolves to ${origin}, which this dictionary does not declare as a base URL`, [{ origin }]);
    }
  }

  private async fetchUpstream(entry: Entry, resolved: ResolvedRequest, timeoutMs: number, secrets: string[]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = { method: resolved.method, headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', ...resolved.headers }, redirect: 'manual', signal: controller.signal };
      if (resolved.body !== undefined && resolved.method !== 'GET' && resolved.method !== 'HEAD') {
        init.body = typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body);
        (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
      }
      let response: Response;
      try {
        response = await this.fetchImpl(resolved.url, init);
      } catch (error) {
        if (controller.signal.aborted) throw new ServiceError(504, 'upstream_timeout', `"${entry.name}" did not answer within ${timeoutMs} ms`, [{ timeoutMs }]);
        throw new ServiceError(502, 'upstream_error', `"${entry.name}" could not be reached: ${redact(errorMessage(error), secrets)}`, []);
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ServiceError(502, 'upstream_redirect', `"${entry.name}" answered ${response.status}; redirects are not followed`, [{ status: response.status }]);
      }
      const { text, bytes, cut } = await readCapped(response, this.config.maxResponseBytes, controller);
      return { status: response.status, contentType: response.headers.get('content-type'), text, bytes, cut };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function errorMessage(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  const inner = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  const outer = error instanceof Error ? error.message : String(error);
  return inner && inner !== outer ? `${outer} (${inner})` : outer;
}

/** Every origin the dictionary's descriptors can produce with the deployment's variables. */
export function declaredOrigins(dictionary: Dictionary, variables: Record<string, string>): Set<string> {
  const origins = new Set<string>();
  const substitute = (text: string): string | null => {
    let missing = false;
    const out = text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, name: string) => {
      const value = variables[name];
      if (value === undefined) missing = true;
      return value === undefined ? '' : encodeURIComponent(value);
    });
    return missing ? null : out;
  };
  for (const entry of dictionary.entries) {
    const call = effectiveCall(entry, dictionary);
    if (call.type !== 'http') continue;
    const base = call.baseUrl ? substitute(call.baseUrl) : substitute(call.urlTemplate.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}.*$/, ''));
    if (base === null) continue;
    try {
      const origin = new URL(base).origin;
      // A host that still holds an input placeholder declares nothing: the
      // caller would be choosing it. Such an entry only reaches hosts that
      // other descriptors declare outright.
      if (origin === 'null' || /[{}]/.test(origin)) continue;
      origins.add(origin);
    } catch {
      // An unresolvable base cannot be a target either.
    }
  }
  return origins;
}

/** Reads at most `cap` bytes, then aborts the upstream so nothing more is transferred. */
async function readCapped(response: Response, cap: number, controller: AbortController): Promise<{ text: string; bytes: number; cut: boolean }> {
  if (!response.body) return { text: '', bytes: 0, cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - bytes));
      bytes = cap;
      cut = true;
      controller.abort();
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, cut };
}

/** The caller's credential is never written back, whatever the upstream echoed. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
}

function shape(
  stamp: DictionaryStamp,
  entry: Entry,
  upstream: { status: number; contentType: string | null; text: string; bytes: number; cut: boolean },
  elapsedMs: number,
  maxBytes: number,
  secrets: string[],
): ExecuteResponse {
  const text = redact(upstream.text, secrets);
  const isJson = /json/i.test(upstream.contentType ?? '');
  let body: unknown = text;
  let bodyFormat: 'json' | 'text' = 'text';
  if (isJson && !upstream.cut) {
    try {
      body = JSON.parse(text);
      bodyFormat = 'json';
    } catch {
      // Declared JSON that does not parse is returned as the text it is.
    }
  }
  const base: ExecuteResponse = {
    kind: 'result',
    dictionary: stamp,
    tool: entry.name,
    status: upstream.status,
    contentType: upstream.contentType,
    body,
    bodyFormat,
    bytes: upstream.bytes,
    truncated: upstream.cut,
    elapsedMs,
    budget: { maxBytes, usedBytes: 0, truncated: false },
  };
  if (settleUsedBytes(base) <= maxBytes) return base;
  // Over budget: the body becomes text cut to fit, exactly (spec 11.5).
  base.bodyFormat = 'text';
  base.truncated = true;
  base.budget.truncated = true;
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, body: '' })) + Buffer.byteLength(JSON.stringify(TRUNCATION_MARK)) - 2;
  let keep = Math.max(0, maxBytes - overhead);
  base.body = cutUtf8(text, keep) + TRUNCATION_MARK;
  let used = settleUsedBytes(base);
  // JSON escaping can cost more than the raw bytes; tighten until it fits.
  while (used > maxBytes && keep > 0) {
    keep = Math.max(0, keep - Math.ceil((used - maxBytes) * 1.2));
    base.body = cutUtf8(text, keep) + TRUNCATION_MARK;
    used = settleUsedBytes(base);
  }
  return base;
}

/**
 * `budget.usedBytes` is part of the bytes it counts, so its own digit count
 * can move the total; iterate until the number describes the document that
 * contains it. Converges in at most two rounds.
 */
function settleUsedBytes(response: ExecuteResponse): number {
  let used = Buffer.byteLength(JSON.stringify(response));
  for (let i = 0; i < 3; i++) {
    response.budget.usedBytes = used;
    const next = Buffer.byteLength(JSON.stringify(response));
    if (next === used) return used;
    used = next;
  }
  response.budget.usedBytes = used;
  return used;
}

/** Cuts on a code-point boundary so the result stays valid UTF-8. */
function cutUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) end--;
  const cut = text.slice(0, end);
  // Do not split a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Spec 11.4 text form of a result: one header line, then the body as-is. */
export function renderExecuteText(response: ExecuteResponse): string {
  const size = response.truncated ? `${response.bytes} bytes, truncated` : `${response.bytes} bytes`;
  const head = `${response.tool} → ${response.status}${response.contentType ? ` ${response.contentType.split(';')[0]}` : ''} (${size})`;
  const body = response.bodyFormat === 'json' ? JSON.stringify(response.body, null, 2) : String(response.body);
  return `${head}\n${body}`;
}
