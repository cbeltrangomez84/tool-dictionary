/**
 * The dictionary service, independent of HTTP: a registry of loaded
 * dictionaries, each with its own search backend, plus the request semantics
 * of spec 9–13 (clamping, index fallback, threshold, pagination, aliases,
 * tombstones, refresh with last-good retention).
 *
 * Each dictionary is an isolation boundary (spec 16.3): its own backend, its
 * own fuzzy index, its own tokens. Nothing here is keyed globally by entry name.
 */
import { readFile } from 'node:fs/promises';
import { etagOf } from './etag';
import { ServiceError, type ErrorCode } from './errors';
import { DEFAULT_EXECUTION, Executor, type ExecuteRequest, type ExecuteResponse, type ExecutionConfig, type IncomingHeaders } from './execute';
import { loadDictionary, LoadError, type BranchFetcher, type LoadedDictionary } from './load';
import { buildIndexResponse, buildResultsResponse, decodeCursor, type BuiltResponse } from './render/budget';
import { renderEntry } from './render/detail';
import type { Hit, SearchBackend } from './search/backend';
import { Bm25Backend } from './search/bm25';
import { FuzzyIndex } from './search/fuzzy';
import type {
  Dictionary,
  EntriesResponse,
  Entry,
  EntryRef,
  IndexNode,
  IndexReason,
  IndexResponse,
  RenderedEntry,
  RequestedDetail,
  ResolvedSearchRequest,
  ResponseFormat,
  ResultsResponse,
  RiskLevel,
  SearchRequest,
  Suggestion,
} from './types';

export { ServiceError, type ErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ThresholdConfig {
  /** A hit below this absolute BM25 score never counts as a match. */
  minScore: number;
  /** A hit below this fraction of the top score is dropped from the page. */
  relativeFloor: number;
}

export interface Limits {
  defaultLimit: number;
  maxLimit: number;
  defaultMaxBytes: number;
  minMaxBytes: number;
  maxMaxBytes: number;
  maxQueryChars: number;
  /** Search deadline; a slower backend returns its partial ranking with a notice (spec 16.5). */
  searchDeadlineMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  defaultLimit: 8,
  maxLimit: 50,
  defaultMaxBytes: 12_000,
  minMaxBytes: 1024,
  maxMaxBytes: 65_536,
  maxQueryChars: 500,
  searchDeadlineMs: 2000,
};

export const DEFAULT_THRESHOLD: ThresholdConfig = { minScore: 1.0, relativeFloor: 0.15 };

export interface DictionarySource {
  kind: 'url' | 'file' | 'inline';
  location?: string;
  refreshIntervalMs?: number;
}

export interface DictionaryConfig {
  /** Explicit id; when absent the document's own id is used. */
  id?: string;
  source: DictionarySource;
  /** Empty = public read. */
  readTokens?: string[];
  adminTokens?: string[];
  threshold?: Partial<ThresholdConfig>;
  /** Overrides `catalog` freshness; seconds. */
  catalogMaxAgeSeconds?: number;
  /**
   * Opt this dictionary out of execution (spec 9.7) on a deployment that has
   * it on. Default true; irrelevant while the deployment keeps execution off.
   */
  execute?: boolean;
}

/** An execute body as it arrives, before anything is trusted about it. */
export interface RawExecuteRequest {
  name?: unknown;
  params?: unknown;
  maxBytes?: unknown;
  format?: unknown;
}

export interface ServiceConfig {
  limits?: Partial<Limits>;
  threshold?: Partial<ThresholdConfig>;
  /** Injected so tests and air-gapped deployments never touch the network. */
  fetchJson?: (url: string) => Promise<unknown>;
  createBackend?: () => SearchBackend;
  /** Admin tokens valid for every dictionary, e.g. for `PUT` of a new id. */
  globalAdminTokens?: string[];
  now?: () => Date;
  /** Catalogue execution (spec 9.7). Off unless `enabled` is set. */
  execution?: Partial<ExecutionConfig>;
  /** The fetch used for upstream calls when executing; injected by tests. */
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

interface Tombstone {
  removedInVersion: number;
  successor?: string;
}

interface Tenant {
  id: string;
  config: DictionaryConfig;
  loaded: LoadedDictionary | null;
  backend: SearchBackend | null;
  fuzzy: FuzzyIndex | null;
  threshold: ThresholdConfig;
  installedAt: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  /** Set when the last refresh failed and we are serving the previous good version. */
  staleSince: string | null;
  /** Names that existed in an earlier version and no longer do (spec 13.4). */
  tombstones: Map<string, Tombstone>;
  timer: NodeJS.Timeout | null;
}

export interface DictionaryStatus {
  id: string;
  loaded: boolean;
  /** From the document; null until loaded. */
  title: string | null;
  summary: string | null;
  version: number | null;
  etag: string | null;
  entryCount: number;
  generatedAt: string | null;
  loadedAt: string | null;
  source: DictionarySource;
  stale: boolean;
  staleSince: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  threshold: ThresholdConfig;
  backend: string | null;
  branches: LoadedDictionary['branches'];
  warnings: number;
  public: boolean;
}

export interface VersionInfo {
  id: string;
  version: number;
  etag: string;
  entryCount: number;
  generatedAt: string;
  loadedAt: string;
  stale: boolean;
  staleSince: string | null;
}

export type Access = 'read' | 'admin';

const DETAILS: RequestedDetail[] = ['ref', 'summary', 'full', 'auto'];
const FORMATS: ResponseFormat[] = ['json', 'text', 'anthropic_tool_reference'];
const RISKS: RiskLevel[] = ['read', 'write', 'destructive', 'admin'];

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------

export class DictionaryService {
  private readonly tenants = new Map<string, Tenant>();
  private readonly limits: Limits;
  private readonly threshold: ThresholdConfig;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly createBackend: () => SearchBackend;
  private readonly globalAdminTokens: Set<string>;
  private readonly now: () => Date;
  private readonly executor: Executor;

  constructor(config: ServiceConfig = {}) {
    this.executor = new Executor({ ...DEFAULT_EXECUTION, ...config.execution }, config.fetch);
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.threshold = { ...DEFAULT_THRESHOLD, ...config.threshold };
    this.fetchJson = config.fetchJson ?? defaultFetchJson;
    this.createBackend = config.createBackend ?? (() => new Bm25Backend());
    this.globalAdminTokens = new Set(config.globalAdminTokens ?? []);
    this.now = config.now ?? (() => new Date());
  }

  get effectiveLimits(): Limits {
    return this.limits;
  }

  /** Execution settings without the deployment's variable values, for status output. */
  get executionSummary(): Omit<ExecutionConfig, 'variables'> & { variables: string[] } {
    const { variables, ...rest } = this.executor.config;
    return { ...rest, variables: Object.keys(variables).sort() };
  }

  // -------------------------------------------------------------------------
  // Installation and refresh
  // -------------------------------------------------------------------------

  /** Register a dictionary and load it from its source. Throws on first-load failure. */
  async install(config: DictionaryConfig, inlineDocument?: unknown): Promise<DictionaryStatus> {
    const raw = inlineDocument ?? (await this.pull(config.source));
    const id = config.id ?? (raw as { id?: unknown })?.id;
    if (typeof id !== 'string') throw new ServiceError(422, 'invalid_dictionary', 'dictionary has no id');
    const tenant = this.tenants.get(id) ?? this.createTenant(id, config);
    tenant.config = config;
    tenant.threshold = { ...this.threshold, ...config.threshold };
    await this.applyDocument(tenant, raw, { requireNewerVersion: false });
    this.scheduleRefresh(tenant);
    return this.status(id);
  }

  /** `PUT /v1/dictionaries/{id}` — replace the document, version must increase (spec 9, 409). */
  async put(id: string, raw: unknown, options: { allowNew?: boolean } = {}): Promise<DictionaryStatus> {
    const existing = this.tenants.get(id);
    if (!existing && !options.allowNew) throw new ServiceError(404, 'not_found', `dictionary "${id}" is not installed`);
    const docId = (raw as { id?: unknown })?.id;
    if (docId !== id) {
      throw new ServiceError(422, 'invalid_dictionary', `document id "${String(docId)}" does not match path id "${id}"`, [{ at: '/id', message: 'must equal the path id' }]);
    }
    const tenant = existing ?? this.createTenant(id, { source: { kind: 'inline' } });
    try {
      await this.applyDocument(tenant, raw, { requireNewerVersion: true });
    } catch (error) {
      // A brand-new id that fails validation must not linger as an empty tenant.
      if (!existing) this.tenants.delete(id);
      throw error;
    }
    tenant.config = { ...tenant.config, source: { kind: 'inline' } };
    this.scheduleRefresh(tenant);
    return this.status(id);
  }

  /** Re-pull from the source. A failed pull keeps the previous good version and marks it stale (spec 13.3). */
  async refresh(id: string): Promise<DictionaryStatus> {
    const tenant = this.requireTenant(id);
    if (tenant.config.source.kind === 'inline') throw new ServiceError(409, 'no_source', `dictionary "${id}" was installed inline and has no source to refresh from`);
    tenant.lastRefreshAt = this.now().toISOString();
    try {
      const raw = await this.pull(tenant.config.source);
      await this.applyDocument(tenant, raw, { requireNewerVersion: false });
      tenant.lastRefreshError = null;
      tenant.staleSince = null;
    } catch (error) {
      tenant.lastRefreshError = error instanceof LoadError ? `${error.message}: ${error.issues.map((i) => `${i.at} ${i.message}`).join('; ')}` : error instanceof Error ? error.message : String(error);
      if (tenant.loaded && !tenant.staleSince) tenant.staleSince = tenant.lastRefreshAt;
      if (!tenant.loaded) throw new ServiceError(503, 'not_loaded', `dictionary "${id}" has never loaded: ${tenant.lastRefreshError}`);
    }
    return this.status(id);
  }

  async remove(id: string): Promise<void> {
    const tenant = this.requireTenant(id);
    if (tenant.timer) clearInterval(tenant.timer);
    await tenant.backend?.close();
    this.tenants.delete(id);
  }

  async close(): Promise<void> {
    for (const id of [...this.tenants.keys()]) await this.remove(id);
  }

  private createTenant(id: string, config: DictionaryConfig): Tenant {
    const tenant: Tenant = {
      id,
      config,
      loaded: null,
      backend: null,
      fuzzy: null,
      threshold: { ...this.threshold, ...config.threshold },
      installedAt: null,
      lastRefreshAt: null,
      lastRefreshError: null,
      staleSince: null,
      tombstones: new Map(),
      timer: null,
    };
    this.tenants.set(id, tenant);
    return tenant;
  }

  private async pull(source: DictionarySource): Promise<unknown> {
    switch (source.kind) {
      case 'url':
        if (!source.location) throw new ServiceError(422, 'invalid_dictionary', 'url source needs a location');
        return this.fetchJson(source.location);
      case 'file':
        if (!source.location) throw new ServiceError(422, 'invalid_dictionary', 'file source needs a location');
        return JSON.parse(await readFile(source.location, 'utf8')) as unknown;
      case 'inline':
        throw new ServiceError(409, 'no_source', 'inline dictionaries carry their document in the request');
    }
  }

  private async applyDocument(tenant: Tenant, raw: unknown, options: { requireNewerVersion: boolean }): Promise<void> {
    const fetchBranch: BranchFetcher = (url) => this.fetchJson(url);
    let loaded: LoadedDictionary;
    try {
      loaded = await loadDictionary(raw, { fetchBranch });
    } catch (error) {
      if (error instanceof LoadError) throw new ServiceError(422, 'invalid_dictionary', error.message, error.issues);
      throw error;
    }
    if (loaded.doc.id !== tenant.id) {
      throw new ServiceError(422, 'invalid_dictionary', `document id "${loaded.doc.id}" does not match installed id "${tenant.id}"`);
    }
    const previous = tenant.loaded;
    if (previous) {
      if (options.requireNewerVersion && loaded.doc.version <= previous.doc.version) {
        throw new ServiceError(409, 'version_conflict', `installed version is ${previous.doc.version}; a replacement must carry a greater version`, [{ installedVersion: previous.doc.version, offeredVersion: loaded.doc.version }]);
      }
      // Same content under the same version: nothing to do, and no churn on the backend.
      if (previous.etag === loaded.etag) return;
      this.recordTombstones(tenant, previous, loaded);
    }

    const backend = this.createBackend();
    await backend.index(loaded.doc.entries, loaded.doc.synonyms ?? {});
    const fuzzy = new FuzzyIndex(loaded.doc.entries);

    const old = tenant.backend;
    tenant.loaded = loaded;
    tenant.backend = backend;
    tenant.fuzzy = fuzzy;
    tenant.installedAt ??= loaded.loadedAt;
    tenant.staleSince = null;
    for (const name of loaded.byName.keys()) tenant.tombstones.delete(name);
    await old?.close();
  }

  private recordTombstones(tenant: Tenant, previous: LoadedDictionary, next: LoadedDictionary): void {
    for (const entry of previous.doc.entries) {
      if (next.byName.has(entry.name)) continue;
      const successor = entry.relations?.find((r) => r.type === 'successor')?.target;
      const tomb: Tombstone = { removedInVersion: next.doc.version };
      if (successor) tomb.successor = successor;
      tenant.tombstones.set(entry.name, tomb);
    }
  }

  private scheduleRefresh(tenant: Tenant): void {
    if (tenant.timer) clearInterval(tenant.timer);
    tenant.timer = null;
    const { source } = tenant.config;
    if (source.kind === 'inline' || !source.refreshIntervalMs || source.refreshIntervalMs <= 0) return;
    tenant.timer = setInterval(() => {
      void this.refresh(tenant.id).catch(() => undefined);
    }, source.refreshIntervalMs);
    tenant.timer.unref();
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  /** Throws 401/403 when `token` does not grant `access` on `id`. Unknown ids throw 404 only after auth, to avoid enumeration. */
  authorize(id: string, access: Access, token: string | undefined): void {
    const tenant = this.tenants.get(id);
    if (access === 'admin') {
      const ok = (token && this.globalAdminTokens.has(token)) || (token && tenant?.config.adminTokens?.includes(token));
      if (!ok) {
        if (!token) throw new ServiceError(401, 'unauthorized', 'admin token required');
        throw new ServiceError(403, 'forbidden', 'token does not grant admin access');
      }
      return;
    }
    if (!tenant) throw new ServiceError(404, 'not_found', `dictionary "${id}" is not installed`);
    const readTokens = tenant.config.readTokens ?? [];
    if (readTokens.length === 0) return;
    if (!token) throw new ServiceError(401, 'unauthorized', 'read token required');
    if (!readTokens.includes(token) && !tenant.config.adminTokens?.includes(token) && !this.globalAdminTokens.has(token)) {
      throw new ServiceError(403, 'forbidden', 'token does not grant read access');
    }
  }

  isAdminToken(token: string | undefined): boolean {
    return !!token && this.globalAdminTokens.has(token);
  }

  private requireTenant(id: string): Tenant {
    const tenant = this.tenants.get(id);
    if (!tenant) throw new ServiceError(404, 'not_found', `dictionary "${id}" is not installed`);
    return tenant;
  }

  private requireLoaded(id: string): Tenant & { loaded: LoadedDictionary; backend: SearchBackend; fuzzy: FuzzyIndex } {
    const tenant = this.requireTenant(id);
    if (!tenant.loaded || !tenant.backend || !tenant.fuzzy) {
      throw new ServiceError(503, 'not_loaded', `dictionary "${id}" is not loaded yet${tenant.lastRefreshError ? `: ${tenant.lastRefreshError}` : ''}`);
    }
    return tenant as Tenant & { loaded: LoadedDictionary; backend: SearchBackend; fuzzy: FuzzyIndex };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  list(token: string | undefined): DictionaryStatus[] {
    return [...this.tenants.values()]
      .filter((t) => {
        const readTokens = t.config.readTokens ?? [];
        if (readTokens.length === 0) return true;
        return !!token && (readTokens.includes(token) || !!t.config.adminTokens?.includes(token) || this.globalAdminTokens.has(token));
      })
      .map((t) => this.status(t.id));
  }

  status(id: string): DictionaryStatus {
    const t = this.requireTenant(id);
    return {
      id: t.id,
      loaded: t.loaded !== null,
      title: t.loaded?.doc.title ?? null,
      summary: t.loaded?.doc.summary ?? null,
      version: t.loaded?.doc.version ?? null,
      etag: t.loaded?.etag ?? null,
      entryCount: t.loaded?.doc.entries.length ?? 0,
      generatedAt: t.loaded?.doc.generatedAt ?? null,
      loadedAt: t.loaded?.loadedAt ?? null,
      source: t.config.source,
      stale: t.staleSince !== null,
      staleSince: t.staleSince,
      lastRefreshAt: t.lastRefreshAt,
      lastRefreshError: t.lastRefreshError,
      threshold: t.threshold,
      backend: t.backend?.kind ?? null,
      branches: t.loaded?.branches ?? [],
      warnings: t.loaded?.warnings.length ?? 0,
      public: (t.config.readTokens ?? []).length === 0,
    };
  }

  version(id: string): VersionInfo {
    const t = this.requireLoaded(id);
    return {
      id: t.id,
      version: t.loaded.doc.version,
      etag: t.loaded.etag,
      entryCount: t.loaded.doc.entries.length,
      generatedAt: t.loaded.doc.generatedAt,
      loadedAt: t.loaded.loadedAt,
      stale: t.staleSince !== null,
      staleSince: t.staleSince,
    };
  }

  catalog(id: string): { doc: Dictionary; etag: string; maxAgeSeconds: number } {
    const t = this.requireLoaded(id);
    return { doc: t.loaded.doc, etag: t.loaded.etag, maxAgeSeconds: t.config.catalogMaxAgeSeconds ?? 60 };
  }

  warnings(id: string): LoadedDictionary['warnings'] {
    return this.requireLoaded(id).loaded.warnings;
  }

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  getEntry(id: string, name: string): { entry: RenderedEntry; etag: string; resolvedFrom?: string } {
    const t = this.requireLoaded(id);
    const entry = t.loaded.byName.get(name);
    if (!entry) {
      const tomb = t.tombstones.get(name);
      if (tomb) throw new ServiceError(404, 'entry_removed', `entry "${name}" was removed in version ${tomb.removedInVersion}`, [tomb]);
      throw new ServiceError(404, 'entry_not_found', `no entry named "${name}"`);
    }
    const rendered = renderEntry(entry, t.loaded.doc, 'full');
    const out: { entry: RenderedEntry; etag: string; resolvedFrom?: string } = { entry: rendered, etag: t.loaded.etag };
    if (entry.name !== name) out.resolvedFrom = name;
    return out;
  }

  /**
   * Every entry as one line (spec 9.5): canonical names only, sorted by path
   * then name so the list reads like the catalogue. `path` narrows to a
   * subtree with the same rule search uses; an unknown path yields an empty
   * list rather than an error, because the agent may have typed it.
   */
  listEntries(id: string, options: { path?: string } = {}): { response: EntriesResponse; etag: string } {
    const t = this.requireLoaded(id);
    const path = options.path?.trim() || null;
    const prefix = path ? `${path}/` : null;
    const entries: EntryRef[] = t.loaded.doc.entries
      .filter((e) => !path || e.path === path || e.path.startsWith(prefix!))
      .sort((a, b) => (a.path === b.path ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path)))
      .map((e) => {
        const ref: EntryRef = { name: e.name, title: e.title, path: e.path };
        if (e.risk && e.risk !== 'read') ref.risk = e.risk;
        return ref;
      });
    return {
      response: {
        kind: 'entries',
        dictionary: { id: t.id, version: t.loaded.doc.version, etag: t.loaded.etag },
        path,
        total: entries.length,
        entries,
      },
      etag: t.loaded.etag,
    };
  }

  /** The document's own identity, for the agent bundle and the dictionary list. */
  describe(id: string): { id: string; version: number; etag: string; title: string; summary: string; entryCount: number } {
    const t = this.requireLoaded(id);
    return {
      id: t.id,
      version: t.loaded.doc.version,
      etag: t.loaded.etag,
      title: t.loaded.doc.title,
      summary: t.loaded.doc.summary,
      entryCount: t.loaded.doc.entries.length,
    };
  }

  batchGet(id: string, names: string[]): { entries: RenderedEntry[]; missing: { name: string; code: ErrorCode; details?: unknown[] }[]; etag: string } {
    const t = this.requireLoaded(id);
    const entries: RenderedEntry[] = [];
    const missing: { name: string; code: ErrorCode; details?: unknown[] }[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const entry = t.loaded.byName.get(name);
      if (!entry) {
        const tomb = t.tombstones.get(name);
        missing.push(tomb ? { name, code: 'entry_removed', details: [tomb] } : { name, code: 'entry_not_found' });
        continue;
      }
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      entries.push(renderEntry(entry, t.loaded.doc, 'full'));
    }
    return { entries, missing, etag: t.loaded.etag };
  }

  // -------------------------------------------------------------------------
  // Index
  // -------------------------------------------------------------------------

  /** The category tree, optionally rooted at `path`, budgeted like a search miss. */
  // -------------------------------------------------------------------------
  // Execution (spec 9.7)
  // -------------------------------------------------------------------------

  /** True when this deployment executes and the dictionary has not opted out. */
  executable(id: string): boolean {
    return this.executor.config.enabled && this.requireTenant(id).config.execute !== false;
  }

  /**
   * Run one catalogue entry on the caller's behalf. `headers` are the incoming
   * request's; the executor reads only the credential header the entry names.
   */
  async execute(id: string, raw: RawExecuteRequest, headers: IncomingHeaders): Promise<ExecuteResponse> {
    const t = this.requireLoaded(id);
    if (!this.executable(id)) throw new ServiceError(403, 'execution_disabled', `dictionary "${id}" does not execute on this deployment; call the endpoint the entry describes`);
    if (typeof raw.name !== 'string' || raw.name.length === 0) throw new ServiceError(400, 'invalid_params', '"name" is required');
    const entry = t.loaded.byName.get(raw.name);
    if (!entry) {
      const tomb = t.tombstones.get(raw.name);
      if (tomb) throw new ServiceError(404, 'entry_removed', `entry "${raw.name}" was removed in version ${tomb.removedInVersion}`, [tomb]);
      throw new ServiceError(404, 'entry_not_found', `no entry named "${raw.name}"`);
    }
    const params = raw.params === undefined ? {} : raw.params;
    const request: ExecuteRequest = { name: entry.name, params: params as Record<string, unknown> };
    if (raw.format === 'text' || raw.format === 'json') request.format = raw.format;
    const maxBytes = clampBytes(raw.maxBytes, this.limits);
    const stamp = { id: t.id, version: t.loaded.doc.version, etag: t.loaded.etag };
    return this.executor.execute(t.loaded.doc, stamp, entry, request, headers, { maxBytes });
  }

  /**
   * The dictionary a service-level call means (spec 9.8): the one named, or the
   * only one the caller can see. Several visible and none named is an error
   * that lists them, never a silent pick.
   */
  resolveDictionary(token: string | undefined, given: unknown): string {
    if (given !== undefined && given !== null && given !== '') {
      if (typeof given !== 'string') throw new ServiceError(400, 'dictionary_required', '"dictionary" must be a string id');
      this.requireTenant(given);
      return given;
    }
    const visible = this.list(token).filter((d) => d.loaded).map((d) => d.id);
    if (visible.length === 1) return visible[0]!;
    if (visible.length === 0) throw new ServiceError(404, 'not_found', 'no dictionary is available to this caller');
    throw new ServiceError(400, 'dictionary_required', `several dictionaries are available; name one in "dictionary": ${visible.join(', ')}`, [{ dictionaries: visible }]);
  }

  index(id: string, options: { path?: string; maxBytes?: number; format?: ResponseFormat } = {}): BuiltResponse<IndexResponse> {
    const t = this.requireLoaded(id);
    const raw: SearchRequest = { query: '' };
    if (options.maxBytes !== undefined) raw.maxBytes = options.maxBytes;
    if (options.format !== undefined) raw.format = options.format;
    if (options.path !== undefined) raw.path = options.path;
    const request = this.resolve(raw);
    let subtree: IndexNode[] | undefined;
    let notice = 'Catalogue of what this dictionary covers. Search with one of the "try" queries or a path.';
    if (options.path) {
      const node = t.loaded.nodeByPath.get(options.path);
      if (node) subtree = [node];
      else notice = `No category at path "${options.path}"; showing the whole catalogue.`;
    }
    return buildIndexResponse(t.loaded, request, 'explicit', notice, [], subtree);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /** Clamp a raw request into a legal one, recording every clamp as a notice (spec 9.1). */
  resolve(raw: SearchRequest & { q?: unknown }): ResolvedSearchRequest {
    const notices: string[] = [];
    const L = this.limits;

    let query = typeof raw.query === 'string' ? raw.query : typeof raw.q === 'string' ? raw.q : '';
    query = query.replace(/[ --]/g, ' ').trim();
    if (query.length > L.maxQueryChars) {
      query = query.slice(0, L.maxQueryChars);
      notices.push(`Query truncated to ${L.maxQueryChars} characters.`);
    }

    let limit = L.defaultLimit;
    if (raw.limit !== undefined && raw.limit !== null) {
      const n = Math.trunc(Number(raw.limit));
      if (!Number.isFinite(n)) notices.push(`Ignored non-numeric limit; using ${L.defaultLimit}.`);
      else if (n < 1) { limit = 1; notices.push('limit raised to 1.'); }
      else if (n > L.maxLimit) { limit = L.maxLimit; notices.push(`limit capped at ${L.maxLimit}.`); }
      else limit = n;
    }

    let detail: RequestedDetail = 'auto';
    if (raw.detail !== undefined) {
      if (DETAILS.includes(raw.detail)) detail = raw.detail;
      else notices.push(`Unknown detail "${String(raw.detail)}"; using auto.`);
    }

    let maxBytes = L.defaultMaxBytes;
    if (raw.maxBytes !== undefined && raw.maxBytes !== null) {
      const n = Math.trunc(Number(raw.maxBytes));
      if (!Number.isFinite(n)) notices.push(`Ignored non-numeric maxBytes; using ${L.defaultMaxBytes}.`);
      else if (n < L.minMaxBytes) { maxBytes = L.minMaxBytes; notices.push(`maxBytes raised to ${L.minMaxBytes}.`); }
      else if (n > L.maxMaxBytes) { maxBytes = L.maxMaxBytes; notices.push(`maxBytes capped at ${L.maxMaxBytes}.`); }
      else maxBytes = n;
    }

    let format: ResponseFormat = 'json';
    if (raw.format !== undefined) {
      if (FORMATS.includes(raw.format)) format = raw.format;
      else notices.push(`Unknown format "${String(raw.format)}"; using json.`);
    }

    let offset = 0;
    if (raw.cursor) {
      const decoded = decodeCursor(raw.cursor);
      if (!decoded) notices.push('Ignored unreadable cursor; starting from the first result.');
      else if (decoded.q !== query) notices.push('Cursor was issued for a different query; starting from the first result.');
      else offset = decoded.o;
    }

    const resolved: ResolvedSearchRequest = {
      query,
      limit,
      detail,
      maxBytes,
      format,
      offset,
      includeRelated: raw.includeRelated === undefined ? true : raw.includeRelated !== false && String(raw.includeRelated) !== 'false',
      notices,
    };
    if (typeof raw.path === 'string' && raw.path.trim()) resolved.path = raw.path.trim().replace(/^\/+|\/+$/g, '');
    if (raw.risk !== undefined) {
      const list = Array.isArray(raw.risk) ? raw.risk : String(raw.risk).split(',');
      const valid = list.map((r) => String(r).trim()).filter((r): r is RiskLevel => RISKS.includes(r as RiskLevel));
      if (valid.length) resolved.risk = valid;
      else notices.push('Ignored risk filter with no valid levels.');
    }
    return resolved;
  }

  async search(id: string, raw: SearchRequest): Promise<BuiltResponse<ResultsResponse | IndexResponse>> {
    const t = this.requireLoaded(id);
    const request = this.resolve(raw);
    const dict = t.loaded;

    if (!request.query) {
      return this.miss(dict, request, 'empty_query', 'Empty query. This is the catalogue of what this dictionary covers; search with one of the "try" queries.', []);
    }

    // Unknown path filter: full index, and say so (spec 12).
    let subtree: IndexNode[] | undefined;
    if (request.path) {
      const node = dict.nodeByPath.get(request.path);
      if (!node) {
        return this.miss(dict, request, 'no_match', `No category at path "${request.path}". Showing the whole catalogue; pick a path from it.`, []);
      }
      subtree = [node];
    }

    // The backend ranks everything that matches; threshold, risk filter and paging are the service's.
    const searchOptions: { limit: number; path?: string } = { limit: dict.doc.entries.length };
    if (request.path) searchOptions.path = request.path;
    const started = Date.now();
    let hits = await t.backend.search(request.query, searchOptions);
    const elapsed = Date.now() - started;
    if (elapsed > this.limits.searchDeadlineMs) request.notices.push(`Search took ${elapsed} ms, over the ${this.limits.searchDeadlineMs} ms deadline; ranking may be partial.`);

    const unfiltered = hits.length;
    if (request.risk) {
      const allowed = new Set(request.risk);
      hits = hits.filter((h) => allowed.has(dict.byName.get(h.name)?.risk ?? 'read'));
    }
    if (hits.length === 0 && unfiltered > 0) {
      const which = request.risk ? `risk filter [${request.risk.join(', ')}]` : `path filter "${request.path}"`;
      return this.miss(dict, request, 'no_match', `Matches exist but the ${which} removed them all. Showing the catalogue${subtree ? ' for that path' : ''}.`, [], subtree);
    }

    const cleared = this.applyThreshold(hits, t.threshold);
    if (cleared.length === 0) {
      const suggestions = t.fuzzy.suggest(request.query, 5);
      const notice = suggestions.length
        ? `Nothing matched "${request.query}" well enough. See the suggestions, or search with one of the "try" queries below.`
        : `Nothing matched "${request.query}". Search with one of the "try" queries below.`;
      return this.miss(dict, request, 'below_threshold', notice, suggestions, subtree);
    }

    // Deprecated results carry their successor in related (spec 10.3 rule 4); collectRelated does this via relations.
    let offset = request.offset;
    if (offset >= cleared.length) {
      request.notices.push('Cursor is past the end of the results; showing the first page.');
      offset = 0;
      request.offset = 0;
    }
    const page = cleared.slice(offset, offset + request.limit);
    const hasMore = offset + page.length < cleared.length;
    const interpretedAs = this.interpret(request.query, page, dict);
    return buildResultsResponse(dict, request, page, hasMore, interpretedAs);
  }

  private applyThreshold(hits: Hit[], threshold: ThresholdConfig): Hit[] {
    const top = hits[0]?.score ?? 0;
    if (top < threshold.minScore) return [];
    const floor = Math.max(threshold.minScore, top * threshold.relativeFloor);
    return hits.filter((h) => h.score >= floor);
  }

  /** The synonym-expanded terms that actually contributed, so a human can see why "hodlers" found holders. */
  private interpret(query: string, page: Hit[], dict: LoadedDictionary): string[] | undefined {
    const synonyms = dict.doc.synonyms;
    if (!synonyms || page.length === 0) return undefined;
    const q = query.toLowerCase();
    const out = new Set<string>();
    for (const [canonical, equivalents] of Object.entries(synonyms)) {
      const group = [canonical, ...equivalents];
      if (group.some((term) => term.toLowerCase() !== canonical.toLowerCase() && q.includes(term.toLowerCase()))) out.add(canonical);
    }
    return out.size ? [...out] : undefined;
  }

  private miss(
    dict: LoadedDictionary,
    request: ResolvedSearchRequest,
    reason: IndexReason,
    notice: string,
    suggestions: Suggestion[],
    subtree?: IndexNode[],
  ): BuiltResponse<IndexResponse> {
    const fullNotice = request.notices.length ? `${request.notices.join(' ')} ${notice}` : notice;
    return buildIndexResponse(dict, request, reason, fullNotice, suggestions, subtree);
  }
}

export { etagOf };
export type { Entry, LoadedDictionary };

/** The response budget for an execution: the search rule (spec 9.1), silently clamped. */
function clampBytes(raw: unknown, limits: Limits): number {
  if (raw === undefined || raw === null) return limits.defaultMaxBytes;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return limits.defaultMaxBytes;
  return Math.min(limits.maxMaxBytes, Math.max(limits.minMaxBytes, n));
}
