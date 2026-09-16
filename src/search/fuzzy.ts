/**
 * Near-miss suggestions for a query that cleared nothing (spec 12.2).
 *
 * Trigram similarity over names, titles and keywords. It is not a search — it
 * runs only after the ranking backend has already said "nothing" — so it can be
 * naive. Its job is to turn "hodl statistics" into "did you mean holders?" in the
 * same round, instead of making the agent guess again.
 */
import type { Entry, Suggestion } from '../types';
import { tokenize } from './normalize';

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface Candidate {
  entry: Entry;
  term: string;
  grams: Set<string>;
}

export class FuzzyIndex {
  private candidates: Candidate[] = [];

  constructor(entries: Entry[]) {
    for (const entry of entries) {
      const terms = new Set<string>([entry.name, entry.title, ...(entry.keywords ?? []), ...(entry.aliases ?? [])]);
      for (const term of terms) {
        const normalized = tokenize(term).join(' ');
        if (normalized) this.candidates.push({ entry, term: normalized, grams: trigrams(normalized) });
      }
    }
  }

  suggest(query: string, limit = 5, minSimilarity = 0.3): Suggestion[] {
    const tokens = tokenize(query, { dropStopwords: true });
    if (tokens.length === 0) return [];
    const probes = [tokens.join(' '), ...tokens].map((t) => ({ text: t, grams: trigrams(t) }));

    const best = new Map<string, { score: number; term: string; entry: Entry }>();
    for (const candidate of this.candidates) {
      let top = 0;
      for (const probe of probes) top = Math.max(top, similarity(probe.grams, candidate.grams));
      if (top < minSimilarity) continue;
      const prior = best.get(candidate.entry.name);
      if (!prior || prior.score < top) best.set(candidate.entry.name, { score: top, term: candidate.term, entry: candidate.entry });
    }

    return [...best.values()]
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit)
      .map(({ entry, term }) => ({ name: entry.name, title: entry.title, why: `did you mean "${term}"?` }));
  }
}
