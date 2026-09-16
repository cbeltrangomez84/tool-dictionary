/**
 * Text normalization shared by indexing and querying (spec 10.2).
 *
 * The rules are deliberately light. Short technical terms are the whole
 * vocabulary here — `pnl`, `lp`, `fdv` — and an aggressive stemmer turns them
 * into noise. What matters is that `holders_count`, `holdersCount` and
 * "holders count" all land on the same tokens, and that a plural does not miss
 * a singular.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'is', 'are', 'was',
  'be', 'this', 'that', 'it', 'its', 'as', 'from', 'do', 'does', 'did', 'i', 'me', 'my', 'we', 'you',
  'your', 'can', 'could', 'would', 'should', 'get', 'give', 'show', 'tell', 'find', 'want', 'need',
  'please', 'what', 'which', 'who', 'how', 'many', 'much', 'there', 'here', 'about', 'some', 'any',
  // Function words that only ever arrive as filler, in a query or in the prose a
  // generator harvests keywords from. Anything that could name a thing an API
  // returns stays out of this list: "second" is a unit, "out" is a direction.
  'he', 'she', 'his', 'her', 'they', 'them', 'their', 'our', 'us', 'has', 'have', 'had', 'were',
  'been', 'being', 'will', 'shall', 'must', 'may', 'if', 'when', 'while', 'then', 'than', 'but',
  'not', 'also', 'just', 'only', 'very', 'more', 'most', 'such', 'same', 'both', 'each', 'every',
  'other', 'into', 'onto', 'per', 'via', 'against', 'between', 'through', 'got', 'way', 'thing',
  'use', 'using', 'used', 'like',
]);

/** Split identifiers into words, keeping the original as well so exact names still match. */
function splitIdentifier(token: string): string[] {
  const parts = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter(Boolean);
  return parts.length > 1 ? [token, ...parts] : [token];
}

/** Plural folding only. `holders` -> `holder`, `addresses` -> `address`, `pnl` untouched. */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || word.endsWith('shes') || word.endsWith('ches') || word.endsWith('xes')) return word.slice(0, -2);
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export interface TokenizeOptions {
  /** Stopwords are stripped from queries only; in a document they are harmless and rare. */
  dropStopwords?: boolean;
}

export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const out: string[] = [];
  const raw = text.replace(/[^\p{L}\p{N}_\-\s]/gu, ' ').split(/\s+/).filter(Boolean);
  for (const chunk of raw) {
    for (const piece of splitIdentifier(chunk)) {
      const lower = piece.toLowerCase();
      if (options.dropStopwords && STOPWORDS.has(lower)) continue;
      out.push(singular(lower));
    }
  }
  return out;
}

/**
 * A synonym table folded into a bidirectional lookup. `{holder: [hodler, owner]}`
 * makes a query for any of the three expand to all three. Multi-word synonyms are
 * tokenized, so "profit and loss" expands from the token sequence, not the phrase.
 */
export class Synonyms {
  private readonly groups = new Map<string, Set<string>>();

  constructor(table: Record<string, string[]> = {}) {
    for (const [canonical, equivalents] of Object.entries(table)) {
      const members = [canonical, ...equivalents].map((term) => tokenize(term).join(' ')).filter(Boolean);
      const group = new Set(members);
      for (const member of members) {
        const existing = this.groups.get(member);
        if (existing) for (const m of group) existing.add(m);
        else this.groups.set(member, group);
      }
    }
  }

  /**
   * Expand a token list. Single tokens expand by direct lookup; multi-token
   * synonyms are matched as sub-sequences of the query. Returns the original
   * tokens followed by every expansion, deduplicated.
   */
  expand(tokens: string[]): string[] {
    if (this.groups.size === 0) return tokens;
    const out = new Set(tokens);
    const joined = tokens.join(' ');
    for (const [member, group] of this.groups) {
      const present = member.includes(' ') ? ` ${joined} `.includes(` ${member} `) : out.has(member);
      if (!present) continue;
      for (const equivalent of group) for (const t of equivalent.split(' ')) out.add(t);
    }
    return [...out];
  }
}
