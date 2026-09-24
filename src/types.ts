/**
 * The Tool Dictionary 0.1 document, as TypeScript.
 *
 * These types mirror spec/schema/dictionary.schema.json. The schema is the
 * normative artifact — it is what a third party validates against — so when the
 * two disagree, the schema wins and this file is the bug.
 */

export type RelationType =
  | 'alternative'
  | 'narrower'
  | 'broader'
  | 'prerequisite'
  | 'enables'
  | 'pairs_with'
  | 'successor'
  | 'predecessor'
  | 'same_data_other_source';

/**
 * Inverse of every relation type. The server materializes the other direction at
 * load time (spec 6.2) because nobody hand-writing a catalog remembers to, and a
 * one-sided graph makes discovery asymmetric for no reason the author intended.
 */
export const INVERSE_RELATION: Record<RelationType, RelationType> = {
  alternative: 'alternative',
  narrower: 'broader',
  broader: 'narrower',
  prerequisite: 'enables',
  enables: 'prerequisite',
  pairs_with: 'pairs_with',
  successor: 'predecessor',
  predecessor: 'successor',
  same_data_other_source: 'same_data_other_source',
};

export type RiskLevel = 'read' | 'write' | 'destructive' | 'admin';
export type Stability = 'stable' | 'beta' | 'deprecated';
export type CostTier = 'free' | 'standard' | 'expensive';

export interface Relation {
  type: RelationType;
  /** An entry name, or "<dictionaryId>#<name>" for a cross-dictionary reference. */
  target: string;
  /** Why the agent might want this instead of, or next to, the entry it hangs off. Rendered verbatim. */
  reason: string;
  weight?: number;
}

/**
 * Who supplies the credential and, optionally, where it goes. `caller` means
 * the executor has it; `in`/`name`/`value` say where to put it. `value` is
 * never a secret: it is a `{{VARIABLE}}` reference (optionally behind a scheme
 * prefix such as `Bearer `), and the variable is resolved by the executor.
 */
export interface Auth {
  kind: 'none' | 'caller';
  hint?: string;
  in?: 'header' | 'query';
  name?: string;
  value?: string;
}

/** A value the executor supplies at call time. The dictionary only ever carries its name. */
export interface Variable {
  /** A secret may only be referenced from `auth.value`, never from a URL, query or header. */
  secret?: boolean;
  description?: string;
}

export interface HttpCall {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  baseUrl?: string;
  urlTemplate: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyTemplate?: unknown;
  auth?: Auth;
  timeoutHintMs?: number;
}

export interface McpCall {
  type: 'mcp';
  server: string;
  tool: string;
  auth?: Auth;
  timeoutHintMs?: number;
}

export interface LocalCall {
  type: 'local';
  handler: string;
  timeoutHintMs?: number;
}

export type Call = HttpCall | McpCall | LocalCall;

/** A JSON Schema object, kept opaque: the dictionary carries it, it never interprets it. */
export type JsonSchema = Record<string, unknown> & { type?: string; properties?: Record<string, unknown> };

export interface EntryExample {
  input: Record<string, unknown>;
  note?: string;
}

export interface Entry {
  name: string;
  title: string;
  /** One plain sentence saying what question this answers. <= 200 chars. */
  summary: string;
  description?: string;
  path: string;
  keywords?: string[];
  input: JsonSchema;
  returns?: string;
  outputSchema?: JsonSchema;
  call: Call;
  relations?: Relation[];
  risk?: RiskLevel;
  stability?: Stability;
  deprecation?: { since?: string; replacedBy?: string; note?: string };
  cost?: { tier?: CostTier; note?: string };
  latencyHintMs?: number;
  examples?: EntryExample[];
  aliases?: string[];
  /**
   * This entry answers the same question as the named entry of this dictionary,
   * in a response small enough for a model's context: an agent should prefer it
   * and reach for the named entry only when it needs the full data (spec 5.6).
   */
  briefOf?: string;
  /** Server-set from the other side's `briefOf`: the entry that is this one's brief. Never authored. */
  brief?: string;
  extensions?: Record<string, unknown>;
}

export interface Branch {
  dictionaryId: string;
  url: string;
  version?: number;
  etag?: string;
}

export interface IndexNode {
  path: string;
  title: string;
  summary: string;
  entryCount?: number;
  sampleQueries?: string[];
  examples?: string[];
  children?: IndexNode[];
  branch?: Branch;
  /** Server-set: this subtree comes from a branch that failed to load. */
  degraded?: boolean;
  extensions?: Record<string, unknown>;
}

export interface DictionaryDefaults {
  baseUrl?: string;
  auth?: Auth;
  headers?: Record<string, string>;
  timeoutHintMs?: number;
  /** Every `{{NAME}}` used anywhere in the document must be declared here. */
  variables?: Record<string, Variable>;
}

export interface Source {
  type: 'openapi' | 'overlay' | 'dictionary' | 'registry' | 'manual';
  url: string;
  fetchedAt?: string;
  etag?: string;
  entryCount?: number;
}

export interface Dictionary {
  toolDictionary: '0.1';
  id: string;
  title: string;
  summary: string;
  version: number;
  generatedAt: string;
  locale?: string;
  defaults?: DictionaryDefaults;
  synonyms?: Record<string, string[]>;
  index: { nodes: IndexNode[] };
  entries: Entry[];
  sources?: Source[];
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Wire types (spec 9)
// ---------------------------------------------------------------------------

export type DetailLevel = 'ref' | 'summary' | 'full';
export type RequestedDetail = DetailLevel | 'auto';
export type ResponseFormat = 'json' | 'text' | 'anthropic_tool_reference';

export interface SearchRequest {
  query?: string;
  limit?: number;
  detail?: RequestedDetail;
  path?: string;
  risk?: RiskLevel[];
  maxBytes?: number;
  format?: ResponseFormat;
  cursor?: string | null;
  includeRelated?: boolean;
}

/** A search request after clamping, with every default resolved. */
export interface ResolvedSearchRequest {
  query: string;
  limit: number;
  detail: RequestedDetail;
  path?: string;
  risk?: RiskLevel[];
  maxBytes: number;
  format: ResponseFormat;
  offset: number;
  includeRelated: boolean;
  /** Human-readable clamps applied, surfaced in `notice` rather than as a 400. */
  notices: string[];
}

export interface DictionaryStamp {
  id: string;
  version: number;
  etag: string;
}

/** An entry rendered at some detail level. Fields above that level are absent. */
export interface RenderedEntry {
  name: string;
  title: string;
  summary?: string;
  path?: string;
  detail: DetailLevel;
  score?: number;
  matchedOn?: string[];
  description?: string;
  input?: JsonSchema;
  returns?: string;
  call?: Call;
  relations?: Relation[];
  risk?: RiskLevel;
  stability?: Stability;
  cost?: { tier?: CostTier; note?: string };
  examples?: EntryExample[];
  /** This entry is the compact answer of the named entry; prefer it (spec 5.6). */
  briefOf?: string;
  /** The named entry answers this one's question in a compact response; prefer it unless the full data is needed. */
  brief?: string;
  /** Only on `related` items: which result it hangs off, and why. */
  via?: { from: string; type: RelationType; reason: string };
}

export interface Budget {
  maxBytes: number;
  usedBytes: number;
  truncated: boolean;
}

export interface ResultsResponse {
  kind: 'results';
  dictionary: DictionaryStamp;
  query: { text: string; interpretedAs?: string[] };
  results: RenderedEntry[];
  related: RenderedEntry[];
  budget: Budget;
  notice: string | null;
  nextCursor: string | null;
}

export type IndexReason = 'empty_query' | 'no_match' | 'below_threshold' | 'explicit';

export interface Suggestion {
  name: string;
  title: string;
  why: string;
}

export interface IndexResponse {
  kind: 'index';
  dictionary: DictionaryStamp;
  query: { text: string };
  reason: IndexReason;
  notice: string;
  suggestions: Suggestion[];
  index: { nodes: IndexNode[] };
  budget: Budget;
}

export type SearchResponse = ResultsResponse | IndexResponse;

/** One line per entry: the cheapest complete view of a dictionary (spec 9.5). */
export interface EntryRef {
  name: string;
  title: string;
  path: string;
  /** Present only when not `read`, same rule as the `summary` detail level. */
  risk?: RiskLevel;
}

export interface EntriesResponse {
  kind: 'entries';
  dictionary: DictionaryStamp;
  /** The `path` filter that was applied, or null for the whole dictionary. */
  path: string | null;
  total: number;
  entries: EntryRef[];
}

/** A tool declaration a consumer can hand to a model as-is (spec 14). */
export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Absolute URL the executor calls with the model's arguments. */
  endpoint: string;
  method: 'GET' | 'POST';
}

/** Everything a consumer needs to wire one dictionary into an agent, in one call (spec 14.4). */
export interface AgentBundle {
  dictionary: DictionaryStamp & { title: string; summary: string; entryCount: number };
  tools: AgentTool[];
  systemPrompt: string;
  /** True when `execute_tool` is declared, i.e. this deployment executes the dictionary (spec 14.5). */
  execute: boolean;
}
