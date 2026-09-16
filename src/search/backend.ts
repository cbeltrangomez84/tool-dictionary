/**
 * The seam between the service and whatever ranks entries (spec 10.5).
 *
 * Everything around a backend — relations, index fallback, budgets, rendering —
 * is the service's job, so a backend only has to answer "which entries, in what
 * order, and why". A vector or hybrid backend implements this and nothing else
 * changes.
 */
import type { Entry } from '../types';

export interface Hit {
  name: string;
  /** Comparable within one query only. */
  score: number;
  /** Which fields contributed, for a human debugging why something ranked. */
  matchedOn: string[];
}

export interface SearchOptions {
  limit: number;
  /** Restrict to entries whose path is this node or below it. */
  path?: string;
}

export interface SearchBackend {
  readonly kind: string;
  index(entries: Entry[], synonyms?: Record<string, string[]>): Promise<void>;
  search(query: string, options: SearchOptions): Promise<Hit[]>;
  close(): Promise<void>;
}
