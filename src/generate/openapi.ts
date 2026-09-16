/**
 * OpenAPI 3.x → Tool Dictionary (spec 15.1).
 *
 * Everything produced here is a seed: names, keywords and relations are
 * mechanical, and the overlay (overlay.ts) is where human knowledge goes.
 * The generator's only promise is that its output validates and is stable —
 * the same OpenAPI document yields the same dictionary, so the ETag only moves
 * when the API does.
 */
import { singular, tokenize } from '../search/normalize';
import type { Auth, Dictionary, Entry, HttpCall, IndexNode, JsonSchema, Relation, RiskLevel, Source, Variable } from '../types';

// ---------------------------------------------------------------------------
// Minimal OpenAPI shapes (only what is read)
// ---------------------------------------------------------------------------

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: Record<string, unknown>;
  $ref?: string;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: { $ref?: string; required?: boolean; description?: string; content?: Record<string, { schema?: Record<string, unknown> }> };
  responses?: Record<string, { $ref?: string; description?: string; content?: Record<string, { schema?: Record<string, unknown> }> }>;
  'x-category'?: string;
  'x-replaced-by'?: string;
  'x-keywords'?: string[];
  'x-hidden'?: boolean;
  security?: Record<string, string[]>[];
}

interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: { url: string; variables?: Record<string, { default?: string }> }[];
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Record<string, unknown> & { parameters?: OpenApiParameter[] }>;
  components?: { schemas?: Record<string, unknown>; parameters?: Record<string, OpenApiParameter>; securitySchemes?: Record<string, SecurityScheme> };
  security?: Record<string, string[]>[];
}

interface SecurityScheme {
  type?: string;
  in?: string;
  name?: string;
  scheme?: string;
  description?: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
type Method = (typeof METHODS)[number];

const RISK_BY_METHOD: Record<Method, RiskLevel> = { get: 'read', head: 'read', post: 'write', put: 'write', patch: 'write', delete: 'destructive' };

/**
 * Success descriptions that say nothing. Fastify writes "Default Response" for
 * every response without an explicit description, and hand-written documents are
 * full of "OK" — copying either into `returns` spends the agent's context to
 * tell it what it already assumed.
 */
const BOILERPLATE_RETURNS = /^(ok|default response|response|success(ful)?( response| operation)?)\.?$/i;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface GenerateOptions {
  id: string;
  title?: string;
  summary?: string;
  version: number;
  generatedAt?: string;
  /** Recorded in `sources[].url`. */
  sourceUrl: string;
  /** Overrides `servers[0]`. */
  baseUrl?: string;
  /** Path segments to strip before deriving names and relations (e.g. ["v1"]). Defaults to leading `v\d+`. */
  stripPrefixes?: string[];
  /** Include operations marked `deprecated`. Default true (they are demoted and carry a successor). */
  includeDeprecated?: boolean;
  /** Category for untagged operations. */
  defaultCategory?: string;
  /** Maximum keyword seeds per entry. */
  maxKeywords?: number;
}

export interface GenerateResult {
  dictionary: Dictionary;
  /** Things a human should look at: skipped operations, name collisions, unresolvable refs. */
  notes: string[];
}

export class GenerateError extends Error {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'general';
}

function toName(text: string): string {
  let name = text
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (!/^[A-Za-z]/.test(name)) name = `op_${name}`.slice(0, 64);
  return name;
}

/**
 * Display text, not search text: this must NOT go through the search tokenizer,
 * which singularizes ("wallets" → "wallet") and would put a stemmed word in
 * front of a human.
 */
function humanize(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()));
  if (!words.length) return text;
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Upstream prose is usually markdown; the dictionary's text rendering is not.
 * `**503**` survives into a prompt as literal asterisks and costs tokens to say
 * nothing, so the markers are removed and the words kept.
 */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^\s{0,3}[#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = plain(text);
  const match = /^(.{1,200}?[.!?])(\s|$)/.exec(clean);
  return fit(match?.[1] ?? clean, LIMITS.entrySummary);
}

/**
 * Field length limits from spec 5.1 and the JSON Schema. Upstream prose is not
 * written to a length, so the generator has to make it fit: a document that does
 * not validate is not a document, and the CLI would refuse to write it.
 */
const LIMITS = {
  dictionaryTitle: 120,
  dictionarySummary: 240,
  entryTitle: 80,
  entrySummary: 200,
  description: 2000,
  returns: 400,
  deprecationNote: 300,
  nodeTitle: 60,
  nodeSummary: 160,
  sampleQuery: 120,
  authHint: 200,
  variableDescription: 200,
  relationReason: 120,
} as const;

/** Cut at a word boundary where there is one, and mark the cut. */
function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** How many entry names a category offers as examples, and how many queries it suggests. */
const MAX_NODE_LISTINGS = 3;

/**
 * Fills a category's `sampleQueries` and `examples` from the entries that live
 * in it. Both are derived, not authored: they have to be re-derived after an
 * overlay moves entries between paths or hides them, or the index advertises a
 * tool that is no longer there. `keep` names the nodes whose field the overlay
 * set by hand — those are the author's, and re-deriving would overwrite them.
 */
export function seedNodeListings(nodes: IndexNode[], entries: Entry[], keep?: { sampleQueries?: ReadonlySet<string>; examples?: ReadonlySet<string> }): void {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  for (const node of nodes) {
    const own = sorted.filter((e) => e.path === node.path);
    if (!keep?.sampleQueries?.has(node.path)) {
      // A node with no entries of its own is a grouping node; it still has to
      // offer a query that works, so it borrows from its descendants.
      const source = own.length ? own : sorted.filter((e) => e.path.startsWith(`${node.path}/`));
      const samples = [...new Set(source.slice(0, MAX_NODE_LISTINGS).map((e) => fit(e.title.toLowerCase().replace(/[.!?]$/, ''), LIMITS.sampleQuery)))];
      if (samples.length) node.sampleQueries = samples;
      else delete node.sampleQueries;
    }
    if (!keep?.examples?.has(node.path)) {
      // Only a node's own entries: naming a descendant here tells the agent the
      // tool is one level up from where it is.
      if (own.length) node.examples = own.slice(0, MAX_NODE_LISTINGS).map((e) => e.name);
      else delete node.examples;
    }
  }
}

const MAX_RETURN_FIELDS = 12;

/**
 * One line describing the success payload, read off its schema. Most documents
 * never write a response description worth repeating, but almost all of them
 * declare the shape — and "what do I get back" is exactly the question the agent
 * would otherwise spend a round to answer.
 */
function describeSchema(schema: Record<string, unknown> | undefined): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const fieldNames = (s: Record<string, unknown> | undefined): string | undefined => {
    const props = s?.properties as Record<string, unknown> | undefined;
    const keys = props ? Object.keys(props) : [];
    if (!keys.length) return undefined;
    const shown = keys.slice(0, MAX_RETURN_FIELDS).join(', ');
    return keys.length > MAX_RETURN_FIELDS ? `${shown}, and ${keys.length - MAX_RETURN_FIELDS} more` : shown;
  };
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    const itemFields = fieldNames(items);
    if (itemFields) return `An array of objects with ${itemFields}.`;
    const itemType = Array.isArray(items?.type) ? (items.type as string[]).find((t) => t !== 'null') : items?.type;
    return typeof itemType === 'string' ? `An array of ${itemType}.` : undefined;
  }
  const own = fieldNames(schema);
  if (own) return `An object with ${own}.`;
  return undefined;
}

/** Path segments that are not parameters, with the version prefix removed. */
function resourceSegments(urlPath: string, strip: RegExp[]): string[] {
  const segments = urlPath.split('/').filter(Boolean);
  while (segments.length && strip.some((re) => re.test(segments[0]!))) segments.shift();
  return segments;
}

class RefResolver {
  private depth = 0;
  constructor(
    private readonly doc: OpenApiDocument,
    private readonly notes: string[],
  ) {}

  resolve<T>(value: T, seen: Set<string> = new Set()): T {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, seen)) as T;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string') {
      const ref = record.$ref;
      if (seen.has(ref)) {
        return { type: 'object', description: `(recursive: ${ref.split('/').pop()})` } as T;
      }
      const target = this.lookup(ref);
      if (target === undefined) {
        this.notes.push(`unresolvable $ref ${ref}`);
        return { type: 'object', description: `(unresolved ${ref})` } as T;
      }
      const next = new Set(seen);
      next.add(ref);
      const { $ref: _ref, ...siblings } = record;
      const resolved = this.resolve(target, next) as Record<string, unknown>;
      return { ...resolved, ...siblings } as T;
    }
    if (++this.depth > 64) {
      this.depth = 0;
      return { type: 'object' } as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = this.resolve(v, seen);
    this.depth--;
    return out as T;
  }

  private lookup(ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let node: unknown = this.doc;
    for (const raw of ref.slice(2).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }
}

/** Keep only the schema keywords that help an agent fill the input; drop vendor noise. */
function pruneSchema(schema: Record<string, unknown> | undefined, depth = 0): JsonSchema {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  if (depth > 6) return { type: 'object' };
  const keep = ['type', 'description', 'enum', 'default', 'format', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'items', 'properties', 'required', 'example', 'examples', 'oneOf', 'anyOf', 'allOf', 'nullable', 'additionalProperties', 'minItems', 'maxItems'];
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    const v = schema[key];
    if (v === undefined) continue;
    if (key === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, Record<string, unknown>>).map(([k, s]) => [k, pruneSchema(s, depth + 1)]));
    } else if (key === 'items' && v && typeof v === 'object') {
      out.items = pruneSchema(v as Record<string, unknown>, depth + 1);
    } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(v)) {
      out[key] = v.map((s) => pruneSchema(s as Record<string, unknown>, depth + 1));
    } else if (key === 'additionalProperties' && v && typeof v === 'object') {
      out.additionalProperties = pruneSchema(v as Record<string, unknown>, depth + 1);
    } else if (key === 'examples' && Array.isArray(v)) {
      out.example = v[0];
    } else if (key === 'example') {
      if (out.example === undefined) out.example = v;
    } else {
      out[key] = v;
    }
  }
  if (Array.isArray(schema.type)) {
    // 3.1 type arrays: keep the non-null member as the type.
    const types = (schema.type as string[]).filter((t) => t !== 'null');
    out.type = types.length === 1 ? types[0] : 'object';
    if ((schema.type as string[]).includes('null')) out.nullable = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateFromOpenApi(rawDoc: unknown, options: GenerateOptions): GenerateResult {
  const notes: string[] = [];
  const doc = rawDoc as OpenApiDocument;
  if (!doc || typeof doc !== 'object') throw new GenerateError('OpenAPI document is not an object');
  if (doc.swagger) throw new GenerateError(`Swagger ${doc.swagger} is not supported; convert to OpenAPI 3.x first`);
  if (!doc.openapi || !/^3\./.test(doc.openapi)) throw new GenerateError(`expected an OpenAPI 3.x document, got openapi="${String(doc.openapi)}"`);
  if (!doc.paths || typeof doc.paths !== 'object') throw new GenerateError('OpenAPI document has no paths');

  const resolver = new RefResolver(doc, notes);
  const strip = (options.stripPrefixes ?? ['v\\d+']).map((p) => new RegExp(`^${p}$`, 'i'));
  const maxKeywords = options.maxKeywords ?? 20;
  const includeDeprecated = options.includeDeprecated ?? true;
  const defaultCategory = slugify(options.defaultCategory ?? 'general');

  const tagDescriptions = new Map<string, string>();
  for (const tag of doc.tags ?? []) if (tag.description) tagDescriptions.set(tag.name, tag.description);

  // Base URL: explicit option, else the first server with variables substituted by their defaults.
  let baseUrl = options.baseUrl;
  if (!baseUrl && doc.servers?.[0]) {
    const server = doc.servers[0];
    baseUrl = server.url.replace(/\{([^}]+)\}/g, (_, v: string) => server.variables?.[v]?.default ?? '');
    if (!/^https?:\/\//.test(baseUrl)) {
      notes.push(`servers[0].url "${server.url}" is relative; defaults.baseUrl omitted — pass --base-url`);
      baseUrl = undefined;
    }
  }

  const security = securityResolver(doc, options.id, notes);

  // First pass: collect operations.
  interface Op {
    method: Method;
    urlPath: string;
    op: OpenApiOperation;
    name: string;
    category: string;
    segments: string[];
    tag: string | undefined;
  }
  /** An operation before it has a name; naming needs to see every candidate first. */
  interface Draft extends Omit<Op, 'name'> {
    /** Method plus the plain path segments: `get_pool`. */
    shortName: string;
    /** The same with the path parameters spelled out: `get_pool_by_chain_by_address`. */
    longName: string;
    /** A usable `operationId`, which always wins. */
    fixedName: string | undefined;
  }
  const drafts: Draft[] = [];
  for (const [urlPath, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const raw = item[method];
      if (!raw || typeof raw !== 'object') continue;
      const op = resolver.resolve(raw as OpenApiOperation);
      if (op['x-hidden']) {
        notes.push(`skipped ${method.toUpperCase()} ${urlPath}: x-hidden`);
        continue;
      }
      if (op.deprecated && !includeDeprecated) {
        notes.push(`skipped ${method.toUpperCase()} ${urlPath}: deprecated`);
        continue;
      }
      const segments = resourceSegments(urlPath, strip);
      const plain = segments.filter((s) => !s.startsWith('{'));
      const candidate = op.operationId ? toName(op.operationId) : undefined;
      const fixedName = candidate && NAME_RE.test(candidate) ? candidate : undefined;
      const shortName = toName([method, ...plain.map(toName)].join('_'));
      const longName = toName([method, ...segments.map((s) => (s.startsWith('{') ? `by_${toName(s.slice(1, -1))}` : toName(s)))].join('_'));
      const tag = op.tags?.[0];
      const category = op['x-category']
        ? op['x-category'].split('/').map(slugify).filter(Boolean).slice(0, 5).join('/')
        : tag
          ? slugify(tag)
          : plain[0]
            ? slugify(plain[0])
            : defaultCategory;
      drafts.push({ method, urlPath, op, category, segments, tag, shortName, longName, fixedName });
    }
  }
  if (drafts.length === 0) throw new GenerateError('no operations found in the OpenAPI document');

  // Naming, second pass. The path parameters are spelled out only when the short
  // form would be ambiguous: `get_pool_by_chain_by_address` buys nothing over
  // `get_pool` when there is one pool operation, and across a few hundred
  // endpoints it puts the same two parameter words into every name, every
  // keyword list and every rendered result.
  const shortCounts = new Map<string, number>();
  for (const d of drafts) if (!d.fixedName) shortCounts.set(d.shortName, (shortCounts.get(d.shortName) ?? 0) + 1);
  const takenNames = new Map<string, number>();
  const ops: Op[] = drafts.map((d) => {
    let name = d.fixedName ?? ((shortCounts.get(d.shortName) ?? 0) > 1 ? d.longName : d.shortName);
    if (!d.fixedName && d.op.operationId) notes.push(`operationId "${d.op.operationId}" is not a valid name; using "${name}"`);
    const count = takenNames.get(name) ?? 0;
    takenNames.set(name, count + 1);
    if (count > 0) {
      const unique = toName(`${name}_${count + 1}`);
      notes.push(`name collision: "${name}" used again by ${d.method.toUpperCase()} ${d.urlPath}; renamed to "${unique}"`);
      name = unique;
    }
    return { method: d.method, urlPath: d.urlPath, op: d.op, name, category: d.category, segments: d.segments, tag: d.tag };
  });

  const nameSet = new Set(ops.map((o) => o.name));

  // Entries.
  const returnsPlaceholders: string[] = [];
  const entries: Entry[] = ops.map((o) => {
    const { op, method, urlPath } = o;
    const pathLevelParams = (doc.paths![urlPath]?.parameters ?? []).map((p) => resolver.resolve(p));
    const params = [...pathLevelParams, ...(op.parameters ?? [])].filter((p) => p && p.name);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const query: Record<string, string> = {};
    const headers: Record<string, string> = {};
    for (const p of params) {
      if (p.in === 'cookie') continue;
      if (p.in === 'header' && /auth|key|token|secret|cookie/i.test(p.name)) continue; // credentials come from the caller's backend
      const propName = toName(p.name);
      const schema = pruneSchema(p.schema);
      if (p.description && !schema.description) schema.description = plain(p.description);
      if (p.deprecated) schema.description = `${schema.description ? `${schema.description} ` : ''}(deprecated)`;
      properties[propName] = schema;
      if (p.required || p.in === 'path') required.push(propName);
      if (p.in === 'query') query[p.name] = `{${propName}}`;
      if (p.in === 'header') headers[p.name] = `{${propName}}`;
    }
    let urlTemplate = urlPath;
    for (const p of params) if (p.in === 'path') urlTemplate = urlTemplate.split(`{${p.name}}`).join(`{${toName(p.name)}}`);
    // Path placeholders with no declared parameter still need an input property.
    for (const m of urlTemplate.matchAll(/\{([^}]+)\}/g)) {
      const prop = toName(m[1]!);
      if (!properties[prop]) {
        properties[prop] = { type: 'string' };
        required.push(prop);
        notes.push(`${method.toUpperCase()} ${urlPath}: path parameter "${m[1]}" is not declared; added as a required string`);
      }
      if (prop !== m[1]) urlTemplate = urlTemplate.split(`{${m[1]}}`).join(`{${prop}}`);
    }

    let bodyTemplate: unknown;
    const body = op.requestBody;
    const bodyContent = body?.content?.['application/json'] ?? body?.content?.[Object.keys(body?.content ?? {})[0] ?? ''];
    if (bodyContent?.schema) {
      const schema = pruneSchema(bodyContent.schema);
      if (schema.type === 'object' && schema.properties) {
        const bodyProps: string[] = [];
        for (const [k, v] of Object.entries(schema.properties)) {
          if (properties[k]) {
            notes.push(`${method.toUpperCase()} ${urlPath}: body property "${k}" shadows a parameter; body property renamed body_${k}`);
            properties[`body_${k}`] = v;
            bodyProps.push(`body_${k}`);
          } else {
            properties[k] = v;
            bodyProps.push(k);
          }
        }
        for (const r of (schema.required as string[] | undefined) ?? []) required.push(properties[r] ? r : `body_${r}`);
        bodyTemplate = Object.fromEntries(bodyProps.map((k) => [k.startsWith('body_') ? k.slice(5) : k, `{${k}}`]));
      } else {
        properties.body = { ...schema, description: schema.description ?? body?.description ?? 'Request body.' };
        if (body?.required) required.push('body');
        bodyTemplate = '{body}';
      }
    }

    const input: JsonSchema = { type: 'object', properties };
    if (required.length) input.required = [...new Set(required)];

    const plainSegments = o.segments.filter((s) => !s.startsWith('{'));

    // A `summary` written upstream as a whole sentence makes a bad title and a
    // good summary. When it does not fit the title limit, the title is derived
    // from the operation instead and the sentence survives as the summary —
    // truncating a title to 80 characters would throw away the better field.
    const upstreamTitle = op.summary ? plain(op.summary) : undefined;
    const derivedTitle = op.operationId
      ? humanize(op.operationId)
      : humanize(plainSegments.slice(-2).join(' ')) || `${method.toUpperCase()} ${urlPath}`;
    let title: string;
    if (upstreamTitle && upstreamTitle.length <= LIMITS.entryTitle) title = upstreamTitle;
    else {
      title = fit(derivedTitle, LIMITS.entryTitle);
      if (upstreamTitle) notes.push(`${o.name}: summary is longer than ${LIMITS.entryTitle} chars for a title; used "${title}" and kept the text as the entry summary`);
    }
    // A summary that only repeats the title tells the agent nothing, so the
    // description's first sentence wins when there is one.
    const described = firstSentence(op.description);
    const summary = described && described !== title ? described : (firstSentence(op.summary) ?? title);
    const keywordSeeds = [
      ...(op['x-keywords'] ?? []),
      ...(op.tags ?? []).map((t) => t.toLowerCase()),
      ...plainSegments.flatMap((s) => tokenize(s)),
      ...(op.operationId ? tokenize(op.operationId) : []),
      ...Object.keys(properties).flatMap((p) => tokenize(p)),
      ...tokenize(op.summary ?? '', { dropStopwords: true }).map(singular),
    ];
    const keywords = [...new Set(keywordSeeds.map((k) => k.trim()).filter((k) => k && k.length <= 60))].slice(0, maxKeywords);

    const call: HttpCall = { type: 'http', method: method.toUpperCase() as HttpCall['method'], urlTemplate };
    if (Object.keys(query).length) call.query = query;
    if (Object.keys(headers).length) call.headers = headers;
    if (bodyTemplate !== undefined) call.bodyTemplate = bodyTemplate;
    const auth = security.forOperation(op, o.name);
    if (auth) call.auth = auth;

    const entry: Entry = { name: o.name, title, summary, path: o.category, keywords, input, call, risk: RISK_BY_METHOD[method] };
    if (op.description && op.description.trim() !== op.summary?.trim()) entry.description = fit(plain(op.description), LIMITS.description);
    const ok = op.responses?.['200'] ?? op.responses?.['201'] ?? op.responses?.['2XX'] ?? op.responses?.default;
    const okText = ok?.description ? plain(ok.description) : undefined;
    const okSchema = ok?.content?.['application/json']?.schema ?? ok?.content?.[Object.keys(ok?.content ?? {})[0] ?? '']?.schema;
    if (okText && !BOILERPLATE_RETURNS.test(okText)) entry.returns = fit(okText, LIMITS.returns);
    else {
      // A placeholder description ("Default Response") is worth less than the
      // schema sitting next to it.
      const derived = describeSchema(okSchema);
      if (derived) entry.returns = fit(derived, LIMITS.returns);
      else if (okText) returnsPlaceholders.push(o.name);
    }
    if (op.deprecated) {
      entry.stability = 'deprecated';
      entry.deprecation = {};
      const replacedBy = op['x-replaced-by'] ? toName(op['x-replaced-by']) : undefined;
      if (replacedBy && nameSet.has(replacedBy)) {
        entry.deprecation.replacedBy = replacedBy;
        entry.relations = [{ type: 'successor', target: replacedBy, reason: 'replaces this deprecated operation' }];
      } else if (replacedBy) {
        notes.push(`${o.name}: x-replaced-by "${op['x-replaced-by']}" is not an operation in this document`);
        entry.deprecation.note = fit(`Replaced by ${op['x-replaced-by']}, which is not in this catalog.`, LIMITS.deprecationNote);
      } else {
        // Spec 17.1 rule 7: a deprecated entry may have no successor, but it may
        // not be silent about it. Say so here; the overlay is where a human
        // names the real replacement.
        entry.deprecation.note = 'Deprecated upstream with no declared replacement; add x-replaced-by or an overlay relation.';
        notes.push(`${o.name}: deprecated with no x-replaced-by; add a successor in the overlay`);
      }
    }
    return entry;
  });

  if (returnsPlaceholders.length) {
    const shown = returnsPlaceholders.slice(0, 5).join(', ');
    const rest = returnsPlaceholders.length > 5 ? `, and ${returnsPlaceholders.length - 5} more` : '';
    notes.push(`${returnsPlaceholders.length} operation(s) describe their success response with a placeholder and declare no schema; "returns" left empty — write it in the overlay: ${shown}${rest}`);
  }

  // Seeded relations, weak and capped. Two operations belong together when they
  // sit under the same resource, or when they answer different questions about
  // the same inputs: /depth/{chain}/{pool} and /volume/{chain}/{pool} are one
  // lookup seen from two sides, and nothing in the document says so. Both are
  // guesses, which is why they are `pairs_with` at weight 0.3 — the overlay is
  // where a human says something stronger.
  const MAX_SEEDED_GROUP = 8;
  const MAX_SEEDED_RELATIONS = 4;
  const groupBy = (key: (op: Op, entry: Entry) => string | undefined): Map<string, Entry[]> => {
    const map = new Map<string, Entry[]>();
    ops.forEach((o, i) => {
      const k = key(o, entries[i]!);
      if (!k) return;
      map.set(k, [...(map.get(k) ?? []), entries[i]!]);
    });
    return map;
  };
  const seed = (groups: Map<string, Entry[]>, reasonFor: (key: string) => string) => {
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      if (group.length > MAX_SEEDED_GROUP) {
        // Relating everything to everything is not knowledge, and picking four
        // of forty arbitrarily is worse than picking none.
        notes.push(fit(`${group.length} entries would be related by "${reasonFor(key)}"; too many to seed mechanically — pick the meaningful pairs in the overlay`, 300));
        continue;
      }
      const reason = fit(reasonFor(key), LIMITS.relationReason);
      for (const entry of group) {
        const relations: Relation[] = entry.relations ? [...entry.relations] : [];
        for (const other of group) {
          if (other === entry || relations.some((r) => r.target === other.name)) continue;
          if (relations.length >= MAX_SEEDED_RELATIONS) break;
          relations.push({ type: 'pairs_with', target: other.name, reason, weight: 0.3 });
        }
        if (relations.length) entry.relations = relations;
      }
    }
  };
  seed(
    groupBy((o) => {
      // The resource is the first plain segment: /tokens/{a}/price and
      // /tokens/{a}/holders are about the same thing even though they differ
      // from the second segment on.
      const plain = o.segments.filter((s) => !s.startsWith('{'));
      return plain[0] ? `${o.category}|${plain[0]}` : undefined;
    }),
    (key) => `same resource: ${key.split('|')[1]}`,
  );
  seed(
    groupBy((o, entry) => {
      const required = (entry.input.required as string[] | undefined) ?? [];
      return required.length ? `${o.category}|${[...required].sort().join(',')}` : undefined;
    }),
    (key) => `same inputs: ${key.split('|')[1]!.split(',').join(', ')}`,
  );

  // Index: one node per category path, nested from the segments.
  const nodesByPath = new Map<string, IndexNode>();
  const roots: IndexNode[] = [];
  const ensureNode = (path: string): IndexNode => {
    const existing = nodesByPath.get(path);
    if (existing) return existing;
    const segments = path.split('/');
    const last = segments[segments.length - 1]!;
    const tagName = ops.find((o) => o.category === path)?.tag;
    const description = tagName ? tagDescriptions.get(tagName) : undefined;
    // A tag written for humans ("Price alerts") is kept verbatim; a tag that is
    // already a slug ("pool-analytics") is not a title, so it is humanized.
    const humanTag = tagName && /[A-Z\s]/.test(tagName) && slugify(tagName) === last;
    const title = fit(humanTag ? tagName! : humanize(last), LIMITS.nodeTitle);
    const node: IndexNode = { path, title, summary: fit(firstSentence(description) ?? `Operations under ${title}.`, LIMITS.nodeSummary) };
    nodesByPath.set(path, node);
    if (segments.length === 1) roots.push(node);
    else {
      const parent = ensureNode(segments.slice(0, -1).join('/'));
      parent.children = [...(parent.children ?? []), node];
    }
    return node;
  };
  for (const entry of entries) ensureNode(entry.path);
  seedNodeListings([...nodesByPath.values()], entries);
  const sortNodes = (nodes: IndexNode[]) => {
    nodes.sort((a, b) => a.path.localeCompare(b.path));
    for (const n of nodes) if (n.children) sortNodes(n.children);
  };
  sortNodes(roots);
  entries.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));

  for (const path of nodesByPath.keys()) {
    if (!path.split('/').every((s) => SEGMENT_RE.test(s))) notes.push(`category path "${path}" does not fit the path charset; fix x-category or tag names`);
  }

  const source: Source = { type: 'openapi', url: options.sourceUrl, entryCount: entries.length };
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  source.fetchedAt = generatedAt;
  if (doc.info?.version) source.etag = `api-version:${doc.info.version}`;

  const dictionary: Dictionary = {
    toolDictionary: '0.1',
    id: options.id,
    title: fit(options.title ?? doc.info?.title ?? options.id, LIMITS.dictionaryTitle),
    summary: fit(options.summary ?? firstSentence(doc.info?.description) ?? `Tools generated from the ${doc.info?.title ?? options.id} API.`, LIMITS.dictionarySummary),
    version: options.version,
    generatedAt,
    index: { nodes: roots },
    entries,
    sources: [source],
  };
  const defaults: Dictionary['defaults'] = {};
  if (baseUrl) defaults.baseUrl = baseUrl.replace(/\/+$/, '');
  security.finish(entries, defaults);
  if (Object.keys(defaults).length) dictionary.defaults = defaults;

  return { dictionary, notes };
}

/**
 * Security schemes become auth placement (spec 5.4, 5.5): the dictionary says
 * which header or query parameter carries the credential and names the variable
 * the executor fills — never a value. The scheme most operations use becomes
 * `defaults.auth`; the others override per entry, and an operation with no
 * requirement gets `kind: none` so the executor sends nothing.
 */
function securityResolver(doc: OpenApiDocument, dictionaryId: string, notes: string[]) {
  const schemes = doc.components?.securitySchemes ?? {};
  const prefix = dictionaryId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'API';
  const apiKeyCount = Object.values(schemes).filter((s) => s.type === 'apiKey').length;
  const declared = new Map<string, Variable>();
  const resolved = new Map<string, Auth | undefined>();

  const variableName = (key: string, scheme: SecurityScheme): string => {
    if (scheme.type === 'apiKey') {
      return apiKeyCount > 1 ? `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` : `${prefix}_API_KEY`;
    }
    if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') return `${prefix}_BASIC_AUTH`;
    return `${prefix}_TOKEN`;
  };
  const describe = (key: string, scheme: SecurityScheme): string => {
    if (scheme.description) return fit(plain(scheme.description), LIMITS.variableDescription);
    if (scheme.type === 'apiKey') return `API key sent as the ${scheme.name ?? key} ${scheme.in ?? 'header'}.`;
    if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') return 'Base64 of user:password for HTTP basic auth.';
    if (scheme.type === 'oauth2') return 'OAuth2 access token.';
    if (scheme.type === 'openIdConnect') return 'OpenID Connect access token.';
    return 'Bearer token.';
  };
  const authFor = (key: string): Auth | undefined => {
    if (resolved.has(key)) return resolved.get(key);
    const scheme = schemes[key];
    let auth: Auth | undefined;
    if (!scheme) {
      notes.push(`security scheme "${key}" is referenced but not defined in components.securitySchemes`);
      auth = { kind: 'caller', hint: `${key}, supplied by the caller's backend` };
    } else if (scheme.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) {
      const name = variableName(key, scheme);
      declared.set(name, { secret: true, description: describe(key, scheme) });
      auth = { kind: 'caller', in: scheme.in, name: scheme.name ?? key, value: `{{${name}}}` };
    } else if (scheme.type === 'apiKey') {
      // A cookie cannot be expressed as a placement; say so and leave the executor to it.
      auth = { kind: 'caller', hint: fit(`${scheme.name ?? key} cookie, supplied by the caller's backend`, LIMITS.authHint) };
    } else if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') {
      const name = variableName(key, scheme);
      declared.set(name, { secret: true, description: describe(key, scheme) });
      auth = { kind: 'caller', in: 'header', name: 'Authorization', value: `Basic {{${name}}}` };
    } else if (scheme.type === 'http' || scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
      const name = variableName(key, scheme);
      declared.set(name, { secret: true, description: describe(key, scheme) });
      auth = { kind: 'caller', in: 'header', name: 'Authorization', value: `Bearer {{${name}}}` };
    } else {
      auth = { kind: 'caller', hint: fit(`${key}, supplied by the caller's backend`, LIMITS.authHint) };
    }
    resolved.set(key, auth);
    return auth;
  };

  const usage = new Map<string, number>();
  const chosen = new Map<string, string | null>();
  return {
    /** The auth the operation needs, or undefined when the document declares no schemes at all. */
    forOperation(op: OpenApiOperation, entryName: string): Auth | undefined {
      if (!Object.keys(schemes).length) return undefined;
      const requirements = op.security ?? doc.security ?? [];
      // `security: [{}]` (or an empty list) means the operation is open.
      const first = requirements.find((r) => Object.keys(r).length);
      if (!first) {
        chosen.set(entryName, null);
        return { kind: 'none' };
      }
      const keys = Object.keys(first);
      if (keys.length > 1) notes.push(`${entryName}: requires ${keys.length} schemes together; only "${keys[0]}" is expressed`);
      const key = keys[0]!;
      chosen.set(entryName, key);
      usage.set(key, (usage.get(key) ?? 0) + 1);
      return authFor(key);
    },
    /** Hoists the majority scheme to defaults and declares the variables the document references. */
    finish(entries: Entry[], defaults: NonNullable<Dictionary['defaults']>): void {
      const [majority] = [...usage.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
      if (majority) defaults.auth = authFor(majority)!;
      for (const entry of entries) {
        // Inheriting the default, or `none` when there is no default to override, says the same thing without the field.
        const key = chosen.get(entry.name);
        if (entry.call.type === 'http' && (key === majority || (key === null && !majority))) delete entry.call.auth;
      }
      if (declared.size) {
        defaults.variables = Object.fromEntries([...declared.entries()].sort(([a], [b]) => a.localeCompare(b)));
      }
    },
  };
}
