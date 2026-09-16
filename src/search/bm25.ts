/**
 * Fielded BM25 over the entry fields the spec says are searchable (spec 10.1),
 * with the recommended field weights as defaults.
 *
 * Why BM25 and not embeddings first: it is deterministic, needs no model and no
 * key, runs in microseconds over a few thousand entries, and — the part that
 * matters when the question is "why did the agent not find the tool" — every
 * score can be explained by pointing at a term in a field. An embedding backend
 * belongs behind the same interface; it does not replace this one.
 */
import type { Entry } from '../types';
import type { Hit, SearchBackend, SearchOptions } from './backend';
import { Synonyms, tokenize } from './normalize';

export type Field =
  | 'keywords'
  | 'name'
  | 'aliases'
  | 'title'
  | 'summary'
  | 'path'
  | 'inputNames'
  | 'description'
  | 'inputDescriptions';

export const DEFAULT_FIELD_WEIGHTS: Record<Field, number> = {
  keywords: 3.0,
  name: 2.5,
  aliases: 2.0,
  title: 2.0,
  summary: 1.5,
  path: 1.2,
  inputNames: 1.0,
  description: 0.8,
  inputDescriptions: 0.5,
};

const FIELDS = Object.keys(DEFAULT_FIELD_WEIGHTS) as Field[];

export interface Bm25Options {
  k1?: number;
  b?: number;
  fieldWeights?: Partial<Record<Field, number>>;
  /** Bonus when the whole normalized query equals one keyword phrase or the entry name. */
  exactPhraseBonus?: number;
  /**
   * Floor for the coordination factor (how much of the query an entry covers).
   * 1 disables it. Lower means "matching every word of the question matters
   * more than matching two of them very well".
   */
  coordFloor?: number;
}

interface Doc {
  name: string;
  path: string;
  deprecated: boolean;
  tf: Map<Field, Map<string, number>>;
  len: Map<Field, number>;
  /** Normalized keyword phrases and the name, for the exact-match bonus. */
  phrases: Set<string>;
}

function fieldTexts(entry: Entry): Record<Field, string[]> {
  const props = (entry.input.properties ?? {}) as Record<string, { description?: unknown }>;
  return {
    keywords: entry.keywords ?? [],
    name: [entry.name],
    aliases: entry.aliases ?? [],
    title: [entry.title],
    summary: [entry.summary],
    path: entry.path.split('/'),
    inputNames: Object.keys(props),
    description: entry.description ? [entry.description] : [],
    inputDescriptions: Object.values(props)
      .map((p) => (typeof p?.description === 'string' ? p.description : ''))
      .filter(Boolean),
  };
}

export class Bm25Backend implements SearchBackend {
  readonly kind = 'bm25';
  private readonly k1: number;
  private readonly b: number;
  private readonly weights: Record<Field, number>;
  private readonly exactPhraseBonus: number;
  private readonly coordFloor: number;

  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLen = new Map<Field, number>();
  private synonyms = new Synonyms();

  constructor(options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.weights = { ...DEFAULT_FIELD_WEIGHTS, ...options.fieldWeights };
    this.exactPhraseBonus = options.exactPhraseBonus ?? 4;
    this.coordFloor = options.coordFloor ?? 0.4;
  }

  async index(entries: Entry[], synonyms: Record<string, string[]> = {}): Promise<void> {
    this.synonyms = new Synonyms(synonyms);
    const docs: Doc[] = [];
    const df = new Map<string, number>();
    const totalLen = new Map<Field, number>();

    for (const entry of entries) {
      const texts = fieldTexts(entry);
      const tf = new Map<Field, Map<string, number>>();
      const len = new Map<Field, number>();
      const seen = new Set<string>();
      const phrases = new Set<string>([tokenize(entry.name).join(' ')]);
      for (const keyword of entry.keywords ?? []) phrases.add(tokenize(keyword).join(' '));
      for (const alias of entry.aliases ?? []) phrases.add(tokenize(alias).join(' '));

      for (const field of FIELDS) {
        const counts = new Map<string, number>();
        let fieldLen = 0;
        for (const text of texts[field]) {
          for (const token of tokenize(text)) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
            fieldLen += 1;
            seen.add(token);
          }
        }
        tf.set(field, counts);
        len.set(field, fieldLen);
        totalLen.set(field, (totalLen.get(field) ?? 0) + fieldLen);
      }
      for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
      docs.push({ name: entry.name, path: entry.path, deprecated: entry.stability === 'deprecated', tf, len, phrases });
    }

    this.docs = docs;
    this.df = df;
    this.avgLen = new Map(FIELDS.map((f) => [f, docs.length ? (totalLen.get(f) ?? 0) / docs.length : 0]));
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // Standard BM25 idf with the +1 that keeps it non-negative for very common terms.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  async search(query: string, options: SearchOptions): Promise<Hit[]> {
    if (this.docs.length === 0) return [];
    const queryTokens = tokenize(query, { dropStopwords: true });
    if (queryTokens.length === 0) return [];
    const expanded = this.synonyms.expand(queryTokens);
    const phrase = queryTokens.join(' ');
    // Which terms stand for which word of the question, so that an entry
    // answering two words very loudly does not beat one that answers all three.
    const expansionsOf = new Map(queryTokens.map((t) => [t, new Set(this.synonyms.expand([t]))]));
    const pathPrefix = options.path ? `${options.path}/` : undefined;

    const hits: Hit[] = [];
    for (const doc of this.docs) {
      if (options.path && doc.path !== options.path && !doc.path.startsWith(pathPrefix!)) continue;

      let score = 0;
      const matched = new Set<Field>();
      const matchedTerms = new Set<string>();
      for (const term of expanded) {
        const idf = this.idf(term);
        if (idf === 0) continue;
        // Synonym expansions count for a little less than what the user typed.
        const termWeight = queryTokens.includes(term) ? 1 : 0.7;
        for (const field of FIELDS) {
          const tf = doc.tf.get(field)?.get(term) ?? 0;
          if (tf === 0) continue;
          const len = doc.len.get(field) ?? 0;
          const avg = this.avgLen.get(field) || 1;
          const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + (this.b * len) / avg));
          score += termWeight * this.weights[field] * idf * norm;
          matched.add(field);
          matchedTerms.add(term);
        }
      }
      if (score === 0) continue;

      // Coordination factor: the share of the question this entry answers at all.
      const covered = queryTokens.filter((t) => [...(expansionsOf.get(t) ?? [])].some((e) => matchedTerms.has(e))).length;
      score *= this.coordFloor + (1 - this.coordFloor) * (covered / queryTokens.length);

      if (doc.phrases.has(phrase)) {
        score += this.exactPhraseBonus;
        matched.add(phrase === tokenize(doc.name).join(' ') ? 'name' : 'keywords');
      }
      // Deprecated entries rank below any live entry with a real score (spec 10.3 rule 4).
      if (doc.deprecated) score *= 0.5;
      hits.push({ name: doc.name, score: Math.round(score * 1000) / 1000, matchedOn: [...matched] });
    }

    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return hits.slice(0, options.limit);
  }

  async close(): Promise<void> {
    this.docs = [];
    this.df.clear();
  }
}
