/**
 * An entry at one of the three detail levels (spec 11.1).
 *
 * `summary` is what the budget is spent on, so it carries exactly what a model
 * needs to decide — and relations, because a relation is a decision aid, not a
 * detail. `full` is what an executor needs to call.
 */
import type { Dictionary, Entry, RenderedEntry, DetailLevel, Relation } from '../types';
import { effectiveCall } from '../load';

export interface RenderOptions {
  score?: number;
  matchedOn?: string[];
  via?: RenderedEntry['via'];
  dropExamples?: boolean;
  /** Truncate `description` to this many characters (degradation step 2). */
  descriptionLimit?: number;
}

/**
 * Strongest first, and never more than five. `weight` is the author's ranking
 * hint and does not survive into the response, so the order is the only thing
 * that carries it: a hand-written relation must come before the four the
 * generator seeded at 0.3, or the agent reads noise and stops reading.
 */
export const MAX_RENDERED_RELATIONS = 5;

export function renderRelations(relations: Relation[] | undefined): Relation[] | undefined {
  if (!relations?.length) return undefined;
  return [...relations]
    .map((relation, at) => ({ relation, at }))
    .sort((a, b) => (b.relation.weight ?? 1) - (a.relation.weight ?? 1) || a.at - b.at)
    .slice(0, MAX_RENDERED_RELATIONS)
    .map(({ relation: { type, target, reason } }) => ({ type, target, reason }));
}

export function renderEntry(entry: Entry, dict: Dictionary, level: DetailLevel, options: RenderOptions = {}): RenderedEntry {
  const out: RenderedEntry = { name: entry.name, title: entry.title, detail: level };
  if (options.score !== undefined) out.score = options.score;
  if (options.matchedOn) out.matchedOn = options.matchedOn;
  if (options.via) out.via = options.via;
  if (level === 'ref') return out;

  out.summary = entry.summary;
  out.path = entry.path;
  const relations = renderRelations(entry.relations);
  if (relations) out.relations = relations;
  // Non-default risk and stability survive down to `summary` (spec 11.1): a model
  // choosing between summarized results must not have to spend a round to learn
  // that one of them writes, or is deprecated.
  if (entry.stability && entry.stability !== 'stable') out.stability = entry.stability;
  if (entry.risk && entry.risk !== 'read') out.risk = entry.risk;
  // Also at `summary`: which of two tools to call is the decision this level exists for.
  if (entry.briefOf !== undefined) out.briefOf = entry.briefOf;
  if (entry.brief !== undefined) out.brief = entry.brief;
  if (level === 'summary') return out;

  if (entry.description) {
    const limit = options.descriptionLimit;
    out.description =
      limit !== undefined && entry.description.length > limit ? `${entry.description.slice(0, limit - 1).trimEnd()}…` : entry.description;
  }
  out.input = entry.input;
  if (entry.returns) out.returns = entry.returns;
  out.call = effectiveCall(entry, dict);
  out.risk = entry.risk ?? 'read';
  out.stability = entry.stability ?? 'stable';
  if (entry.cost) out.cost = entry.cost;
  if (entry.examples?.length && !options.dropExamples) out.examples = entry.examples;
  return out;
}
