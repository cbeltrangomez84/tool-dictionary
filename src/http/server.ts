/**
 * HTTP surface (spec 9). Thin: parse, authorize, call the service, set the
 * headers the spec requires (ETag, Cache-Control on /catalog, Retry-After on
 * 503), and render errors as `{ error: { code, message, details } }`.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { agentBundle, usagePrompt } from '../agent';
import { etagMatches } from '../etag';
import { renderEntriesText } from '../render/text';
import { DictionaryService, ServiceError, type Access } from '../service';
import type { SearchRequest } from '../types';

export interface ServerOptions {
  service: DictionaryService;
  /** Request body cap (spec 16.5). */
  bodyLimitBytes?: number;
  logger?: boolean;
  /** Simple per-token/IP rate limit; 0 disables. */
  rateLimitPerMinute?: number;
  /**
   * The URL clients reach this server at, e.g. `https://data.example.com`.
   * Used to fill absolute endpoints in the agent bundle (spec 14.4). When
   * absent the request's own scheme and host are used, which is right unless
   * a proxy rewrites them.
   */
  publicBaseUrl?: string;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

function errorBody(error: ServiceError) {
  return { error: { code: error.code, message: error.message, details: error.details } };
}

type Params = { id: string; name?: string };

class RateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly perMinute: number) {}
  /** Returns seconds to wait, or 0 when allowed. */
  hit(key: string, now = Date.now()): number {
    if (this.perMinute <= 0) return 0;
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.buckets.set(key, { count: 1, windowStart: now });
      if (this.buckets.size > 10_000) this.sweep(now);
      return 0;
    }
    bucket.count += 1;
    if (bucket.count > this.perMinute) return Math.ceil((bucket.windowStart + 60_000 - now) / 1000);
    return 0;
  }
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.windowStart >= 60_000) this.buckets.delete(key);
  }
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { service } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: options.bodyLimitBytes ?? 32 * 1024 });
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? 600);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      if (error.status === 503) reply.header('retry-after', '5');
      return reply.status(error.status).send(errorBody(error));
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) app.log.error(error);
    const code = status === 413 ? 'body_too_large' : status === 400 ? 'bad_request' : 'internal';
    const message = status >= 500 ? 'internal error' : error instanceof Error ? error.message : String(error);
    return reply.status(status).send({ error: { code, message, details: [] } });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'no such route', details: [] } }));

  app.addHook('onRequest', async (request, reply) => {
    const key = bearer(request) ?? request.ip;
    const wait = limiter.hit(key);
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'too many requests', details: [] } });
    }
  });

  const guard = (request: FastifyRequest, id: string, access: Access) => service.authorize(id, access, bearer(request));
  const baseUrlOf = (request: FastifyRequest) => (options.publicBaseUrl ?? `${request.protocol}://${request.host}`).replace(/\/+$/, '');
  const endpointsOf = (request: FastifyRequest, id: string) => {
    const root = `${baseUrlOf(request)}/v1/dictionaries/${encodeURIComponent(id)}`;
    return { search: `${root}/search`, entries: `${root}/entries`, index: `${root}/index`, tool: `${root}/tool`, catalog: `${root}/catalog` };
  };

  const sendSearch = (reply: FastifyReply, built: { body: string; response: { budget: { usedBytes: number; truncated: boolean } } }, format: string | undefined, etag: string) => {
    reply.header('etag', etag);
    reply.header('x-budget-used-bytes', String(built.response.budget.usedBytes));
    reply.header('x-budget-truncated', String(built.response.budget.truncated));
    reply.header('cache-control', 'no-store');
    reply.type(format === 'text' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
    return reply.send(built.body);
  };

  // --- health ---------------------------------------------------------------
  app.get('/v1/health', async (request) => {
    const token = bearer(request);
    return {
      ok: true,
      now: new Date().toISOString(),
      limits: service.effectiveLimits,
      dictionaries: service.list(token),
    };
  });

  // --- list -----------------------------------------------------------------
  // One call tells a consumer what is available and how to use it (spec 9.6):
  // identity and summary per dictionary, its endpoints, and a prompt paragraph
  // covering every dictionary that is actually loaded.
  app.get('/v1/dictionaries', async (request) => {
    const token = bearer(request);
    const listed = service.list(token);
    return {
      dictionaries: listed.map((d) => ({
        id: d.id,
        title: d.title,
        summary: d.summary,
        version: d.version,
        etag: d.etag,
        entryCount: d.entryCount,
        loaded: d.loaded,
        stale: d.stale,
        public: d.public,
        endpoints: endpointsOf(request, d.id),
      })),
      usage: usagePrompt(listed.filter((d) => d.loaded).map((d) => ({ id: d.id, title: d.title!, summary: d.summary! }))),
    };
  });

  // --- agent bundle ---------------------------------------------------------
  app.get<{ Params: Params }>('/v1/dictionaries/:id/tool', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const bundle = agentBundle(baseUrlOf(request), service.describe(request.params.id));
    reply.header('etag', bundle.dictionary.etag);
    reply.header('cache-control', 'max-age=60, must-revalidate');
    if (etagMatches(request.headers['if-none-match'], bundle.dictionary.etag)) return reply.status(304).send();
    return bundle;
  });

  // --- search ---------------------------------------------------------------
  const handleSearch = async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply, raw: SearchRequest) => {
    guard(request, request.params.id, 'read');
    const built = await service.search(request.params.id, raw);
    const version = service.version(request.params.id);
    return sendSearch(reply, built, raw.format, version.etag);
  };

  app.post<{ Params: Params; Body: unknown }>('/v1/dictionaries/:id/search', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as SearchRequest) : {};
    return handleSearch(request, reply, body);
  });

  app.get<{ Params: Params; Querystring: Record<string, string | string[] | undefined> }>('/v1/dictionaries/:id/search', async (request, reply) => {
    const q = request.query;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const raw: SearchRequest = {};
    const query = one(q.query) ?? one(q.q);
    if (query !== undefined) raw.query = query;
    if (one(q.limit) !== undefined) raw.limit = Number(one(q.limit));
    const detail = one(q.detail);
    if (detail !== undefined) raw.detail = detail as NonNullable<SearchRequest['detail']>;
    if (one(q.path) !== undefined) raw.path = one(q.path) as string;
    if (q.risk !== undefined) raw.risk = (Array.isArray(q.risk) ? q.risk : [q.risk]).flatMap((r) => r.split(',')) as NonNullable<SearchRequest['risk']>;
    if (one(q.maxBytes) !== undefined) raw.maxBytes = Number(one(q.maxBytes));
    const format = one(q.format);
    if (format !== undefined) raw.format = format as NonNullable<SearchRequest['format']>;
    if (one(q.cursor) !== undefined) raw.cursor = one(q.cursor) as string;
    if (one(q.includeRelated) !== undefined) raw.includeRelated = one(q.includeRelated) !== 'false';
    return handleSearch(request, reply, raw);
  });

  // --- index ----------------------------------------------------------------
  app.get<{ Params: Params; Querystring: Record<string, string | undefined> }>('/v1/dictionaries/:id/index', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const options: Parameters<DictionaryService['index']>[1] = {};
    if (request.query.path) options.path = request.query.path;
    if (request.query.maxBytes) options.maxBytes = Number(request.query.maxBytes);
    if (request.query.format === 'text' || request.query.format === 'json') options.format = request.query.format;
    const built = service.index(request.params.id, options);
    const version = service.version(request.params.id);
    if (etagMatches(request.headers['if-none-match'], version.etag)) return reply.status(304).header('etag', version.etag).send();
    return sendSearch(reply, built, options.format, version.etag);
  });

  // --- entries --------------------------------------------------------------
  app.get<{ Params: Params; Querystring: Record<string, string | undefined> }>('/v1/dictionaries/:id/entries', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const options: Parameters<DictionaryService['listEntries']>[1] = {};
    if (request.query.path) options.path = request.query.path;
    const { response, etag } = service.listEntries(request.params.id, options);
    reply.header('etag', etag);
    reply.header('cache-control', 'max-age=60, must-revalidate');
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.status(304).send();
    if (request.query.format === 'text') return reply.type('text/plain; charset=utf-8').send(renderEntriesText(response));
    return response;
  });

  app.get<{ Params: Params }>('/v1/dictionaries/:id/entries/:name', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const { entry, etag, resolvedFrom } = service.getEntry(request.params.id, request.params.name ?? '');
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.status(304).header('etag', etag).send();
    reply.header('etag', etag);
    reply.header('cache-control', 'max-age=60, must-revalidate');
    return { dictionary: stampOf(service, request.params.id), entry, ...(resolvedFrom ? { resolvedFrom } : {}) };
  });

  app.post<{ Params: Params; Body: { names?: unknown } }>('/v1/dictionaries/:id/entries:batchGet', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const names = Array.isArray(request.body?.names) ? request.body.names.filter((n): n is string => typeof n === 'string').slice(0, 50) : [];
    const result = service.batchGet(request.params.id, names);
    reply.header('etag', result.etag);
    return { dictionary: stampOf(service, request.params.id), entries: result.entries, missing: result.missing };
  });

  // --- catalog / version ----------------------------------------------------
  app.get<{ Params: Params }>('/v1/dictionaries/:id/catalog', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const { doc, etag, maxAgeSeconds } = service.catalog(request.params.id);
    reply.header('etag', etag);
    reply.header('cache-control', `max-age=${maxAgeSeconds}, must-revalidate`);
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.status(304).send();
    return doc;
  });

  app.get<{ Params: Params }>('/v1/dictionaries/:id/version', async (request, reply) => {
    guard(request, request.params.id, 'read');
    const info = service.version(request.params.id);
    reply.header('etag', info.etag);
    reply.header('cache-control', 'no-cache');
    if (etagMatches(request.headers['if-none-match'], info.etag)) return reply.status(304).send();
    return info;
  });

  // --- admin ----------------------------------------------------------------
  app.put<{ Params: Params; Body: unknown }>('/v1/dictionaries/:id', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const token = bearer(request);
    guard(request, request.params.id, 'admin');
    const status = await service.put(request.params.id, request.body, { allowNew: service.isAdminToken(token) });
    return reply.status(200).send(status);
  });

  app.post<{ Params: Params }>('/v1/dictionaries/:id/refresh', async (request) => {
    guard(request, request.params.id, 'admin');
    return service.refresh(request.params.id);
  });

  app.get<{ Params: Params }>('/v1/dictionaries/:id/warnings', async (request) => {
    guard(request, request.params.id, 'admin');
    return { warnings: service.warnings(request.params.id) };
  });

  return app;
}

function stampOf(service: DictionaryService, id: string) {
  const v = service.version(id);
  return { id: v.id, version: v.version, etag: v.etag };
}
