/**
 * Builds a search response that fits `maxBytes` (spec 11).
 *
 * The response is measured, not estimated: every candidate is serialized in the
 * requested format and its byte length compared. Degradation follows the order
 * in spec 11.3 — examples, description, detail level from the bottom up, related
 * beyond three, tail results, related entirely — and rank 1 stays at `full`
 * until the very last step, because the point of the whole exercise is to
 * return something callable.
 */
import type { LoadedDictionary } from '../load';
import type { Hit } from '../search/backend';
import type {
  Budget,
  DetailLevel,
  DictionaryStamp,
  IndexNode,
  IndexReason,
  IndexResponse,
  RenderedEntry,
  ResolvedSearchRequest,
  ResultsResponse,
  Suggestion,
} from '../types';
import { renderEntry } from './detail';
import { renderIndexText, renderResultsText } from './text';

/** How many results `auto` renders at full detail (spec 11.2). */
export const AUTO_FULL_COUNT = 3;
/** Related items kept in degradation step 4. */
const RELATED_FLOOR = 3;
/** Description length after degradation step 2. */
const DESCRIPTION_LIMIT = 300;
/** Related items offered before any degradation. */
const MAX_RELATED = 6;

export function serialize(response: ResultsResponse | IndexResponse, format: ResolvedSearchRequest['format']): string {
  if (format === 'text') return response.kind === 'results' ? renderResultsText(response) : renderIndexText(response);
  if (format === 'anthropic_tool_reference') {
    const names = response.kind === 'results' ? [...response.results, ...response.related.slice(0, 3)].map((e) => e.name) : [];
    return JSON.stringify({ content: names.map((tool_name) => ({ type: 'tool_reference', tool_name })) });
  }
  return JSON.stringify(response);
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function encodeCursor(query: string, offset: number): string {
  return Buffer.from(JSON.stringify({ q: query, o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): { q: string; o: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { q?: unknown; o?: unknown };
    if (typeof parsed.q !== 'string' || typeof parsed.o !== 'number' || !Number.isInteger(parsed.o) || parsed.o < 0) return null;
    return { q: parsed.q, o: parsed.o };
  } catch {
    return null;
  }
}

interface Plan {
  hits: Hit[];
  levels: DetailLevel[];
  dropExamples: boolean;
  descriptionLimit: number | undefined;
  relatedCount: number;
}

function stamp(dict: LoadedDictionary): DictionaryStamp {
  return { id: dict.doc.id, version: dict.doc.version, etag: dict.etag };
}

function initialLevels(request: ResolvedSearchRequest, count: number): DetailLevel[] {
  if (request.detail === 'auto') return Array.from({ length: count }, (_, i) => (i < AUTO_FULL_COUNT ? 'full' : 'summary'));
  return Array.from({ length: count }, () => request.detail as DetailLevel);
}

/** Related entries, deduplicated against results and against each other, best weight first. */
function collectRelated(dict: LoadedDictionary, hits: Hit[]): RenderedEntry[] {
  const inResults = new Set(hits.map((h) => h.name));
  const seen = new Set<string>();
  const out: { entry: RenderedEntry; weight: number; rank: number }[] = [];
  hits.forEach((hit, rank) => {
    const from = dict.byName.get(hit.name);
    for (const rel of from?.relations ?? []) {
      if (rel.target.includes('#')) continue;
      const target = dict.byName.get(rel.target);
      if (!target || inResults.has(target.name) || seen.has(target.name)) continue;
      seen.add(target.name);
      out.push({
        rank,
        weight: rel.weight ?? 1,
        entry: renderEntry(target, dict.doc, 'summary', { via: { from: from!.name, type: rel.type, reason: rel.reason } }),
      });
    }
  });
  // Relations of higher-ranked results first; within one result, heavier first.
  out.sort((a, b) => a.rank - b.rank || b.weight - a.weight);
  return out.map((o) => o.entry);
}

function realize(
  dict: LoadedDictionary,
  request: ResolvedSearchRequest,
  plan: Plan,
  related: RenderedEntry[],
  notices: string[],
  nextCursor: string | null,
  interpretedAs: string[] | undefined,
): ResultsResponse {
  const results = plan.hits.map((hit, i) => {
    const entry = dict.byName.get(hit.name)!;
    const options: Parameters<typeof renderEntry>[3] = { score: hit.score, matchedOn: hit.matchedOn, dropExamples: plan.dropExamples };
    if (plan.descriptionLimit !== undefined) options.descriptionLimit = plan.descriptionLimit;
    return renderEntry(entry, dict.doc, plan.levels[i] ?? 'summary', options);
  });
  const query: ResultsResponse['query'] = { text: request.query };
  if (interpretedAs?.length) query.interpretedAs = interpretedAs;
  return {
    kind: 'results',
    dictionary: stamp(dict),
    query,
    results,
    related: related.slice(0, plan.relatedCount),
    budget: { maxBytes: request.maxBytes, usedBytes: 0, truncated: false },
    notice: notices.length ? notices.join(' ') : null,
    nextCursor,
  };
}

export interface BuiltResponse<T> {
  response: T;
  body: string;
}

/**
 * `pageHits` is the requested page; `hasMore` says whether a cursor is
 * warranted even before any degradation.
 *
 * Every candidate is fully realized — notice included, `budget.usedBytes`
 * settled — before it is measured, so the measured body is the body sent.
 */
export function buildResultsResponse(
  dict: LoadedDictionary,
  request: ResolvedSearchRequest,
  pageHits: Hit[],
  hasMore: boolean,
  interpretedAs?: string[],
): BuiltResponse<ResultsResponse> {
  const related = request.includeRelated ? collectRelated(dict, pageHits) : [];
  const plan: Plan = {
    hits: [...pageHits],
    levels: initialLevels(request, pageHits.length),
    dropExamples: false,
    descriptionLimit: undefined,
    relatedCount: Math.min(related.length, MAX_RELATED),
  };
  let nextCursor = hasMore ? encodeCursor(request.query, request.offset + pageHits.length) : null;

  const attempt = (stepNotice: string | undefined, truncated: boolean): BuiltResponse<ResultsResponse> => {
    const notices = stepNotice ? [...request.notices, stepNotice] : [...request.notices];
    const response = realize(dict, request, plan, related, notices, nextCursor, interpretedAs);
    return settle(response, request.format, truncated);
  };
  const fits = (built: BuiltResponse<ResultsResponse>) => byteLength(built.body) <= request.maxBytes;

  let built = attempt(undefined, false);
  if (fits(built)) return built;

  // Spec 11.3, in order. Each step is applied, then the whole response is re-measured.
  const steps: { apply: () => boolean; notice: string }[] = [
    {
      apply: () => ((plan.dropExamples = true), true),
      notice: 'Examples omitted to fit the response budget.',
    },
    {
      apply: () => ((plan.descriptionLimit = DESCRIPTION_LIMIT), true),
      notice: 'Descriptions shortened to fit the response budget.',
    },
    ...plan.levels
      .map((_, i) => i)
      .filter((i) => i >= 1)
      .reverse()
      .map((i) => ({
        apply: () => {
          if (plan.levels[i] !== 'full') return false;
          plan.levels[i] = 'summary';
          return true;
        },
        notice: 'Some results reduced to summary to fit the response budget; search by exact name for the full definition.',
      })),
    {
      apply: () => {
        if (plan.relatedCount <= RELATED_FLOOR) return false;
        plan.relatedCount = RELATED_FLOOR;
        return true;
      },
      notice: 'Related tools trimmed to fit the response budget.',
    },
    ...plan.hits.slice(1).map(() => ({
      apply: () => {
        if (plan.hits.length <= 1) return false;
        plan.hits.pop();
        plan.levels.pop();
        nextCursor = encodeCursor(request.query, request.offset + plan.hits.length);
        return true;
      },
      notice: 'Fewer results returned to fit the response budget; a cursor continues the list.',
    })),
    {
      apply: () => {
        if (plan.relatedCount === 0) return false;
        plan.relatedCount = 0;
        return true;
      },
      notice: 'Related tools omitted to fit the response budget.',
    },
    {
      apply: () => {
        if (plan.levels[0] === 'summary' || plan.levels[0] === 'ref') return false;
        plan.levels[0] = 'summary';
        return true;
      },
      notice: `The definition of ${plan.hits[0]?.name ?? ''} exceeds the response budget; fetch it from /entries/${plan.hits[0]?.name ?? ''}.`,
    },
  ];

  for (const step of steps) {
    if (!step.apply()) continue;
    built = attempt(step.notice, true);
    if (fits(built)) return built;
  }
  // Even one summary result overflows: only possible with a pathological entry
  // and the smallest budget. Return the ref form so the name at least survives.
  plan.levels[0] = 'ref';
  return attempt(`Only the name of ${plan.hits[0]?.name ?? ''} fits the response budget; fetch it from /entries/${plan.hits[0]?.name ?? ''}.`, true);
}

/**
 * Stamp `budget` and serialize until `usedBytes` matches the body it lives in.
 * The digit count of `usedBytes` can change between passes, so this iterates;
 * it converges in two passes in practice and is capped at four.
 */
function settle<T extends ResultsResponse | IndexResponse>(response: T, format: ResolvedSearchRequest['format'], truncated: boolean): BuiltResponse<T> {
  const budget: Budget = { maxBytes: response.budget.maxBytes, usedBytes: 0, truncated };
  response.budget = budget;
  let body = serialize(response, format);
  for (let pass = 0; pass < 4; pass++) {
    const used = byteLength(body);
    if (used === budget.usedBytes) break;
    budget.usedBytes = used;
    body = serialize(response, format);
  }
  return { response, body };
}

// ---------------------------------------------------------------------------
// Index responses (spec 12)
// ---------------------------------------------------------------------------

function pruneNodes(nodes: IndexNode[], depth: number, focus: string | undefined, level = 0): IndexNode[] {
  return nodes.map((node) => {
    const onFocusPath = focus !== undefined && (focus === node.path || focus.startsWith(`${node.path}/`) || node.path.startsWith(`${focus}/`));
    const allowed = onFocusPath ? depth + 1 : depth;
    const out: IndexNode = { path: node.path, title: node.title, summary: node.summary, entryCount: node.entryCount ?? 0 };
    if (node.sampleQueries?.length) out.sampleQueries = node.sampleQueries;
    if (node.examples?.length) out.examples = node.examples;
    if (node.degraded) out.degraded = true;
    if (node.children?.length && level + 1 < allowed) out.children = pruneNodes(node.children, depth, focus, level + 1);
    return out;
  });
}

/** Strip sampleQueries/examples as a last resort, keeping title + summary + count. */
function bareNodes(nodes: IndexNode[]): IndexNode[] {
  return nodes.map(({ path, title, summary, entryCount, degraded }) => ({ path, title, summary, entryCount: entryCount ?? 0, ...(degraded ? { degraded } : {}) }));
}

export function buildIndexResponse(
  dict: LoadedDictionary,
  request: ResolvedSearchRequest,
  reason: IndexReason,
  notice: string,
  suggestions: Suggestion[],
  subtree?: IndexNode[],
): BuiltResponse<IndexResponse> {
  const roots = subtree ?? dict.doc.index.nodes;
  const attempt = (nodes: IndexNode[], sugg: Suggestion[]): BuiltResponse<IndexResponse> => {
    const response: IndexResponse = {
      kind: 'index',
      dictionary: stamp(dict),
      query: { text: request.query },
      reason,
      notice,
      suggestions: sugg,
      index: { nodes },
      budget: { maxBytes: request.maxBytes, usedBytes: 0, truncated: false },
    };
    return settle(response, request.format, false);
  };

  const candidates: (() => BuiltResponse<IndexResponse>)[] = [
    () => attempt(pruneNodes(roots, 2, request.path), suggestions),
    () => attempt(pruneNodes(roots, 1, request.path), suggestions),
    () => attempt(bareNodes(pruneNodes(roots, 1, undefined)), suggestions.slice(0, 2)),
    () => attempt(bareNodes(pruneNodes(roots, 1, undefined)), []),
  ];
  let built = candidates[0]!();
  for (let i = 1; i < candidates.length && byteLength(built.body) > request.maxBytes; i++) {
    built = settle(candidates[i]!().response, request.format, true);
  }
  return built;
}
