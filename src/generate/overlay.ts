/**
 * Overlay merge (spec 15.2): `generate(openapi) + overlay = dictionary`.
 *
 * The overlay is where a human records what a generator cannot know — that two
 * adjacent endpoints are alternatives, what people actually call a thing, which
 * query a category should suggest. The merge is deterministic and every overlay
 * key that no longer matches anything is reported, because a silent overlay is
 * a stale overlay.
 */
import type { Dictionary, DictionaryDefaults, Entry, IndexNode, Relation } from '../types';
import { seedNodeListings } from './openapi';
import { flattenNodes } from '../validate';

export interface ListPatch<T> {
  add?: T[];
  remove?: T[];
}

export interface EntryOverlay {
  title?: string;
  summary?: string;
  description?: string;
  path?: string;
  returns?: string;
  risk?: Entry['risk'];
  stability?: Entry['stability'];
  deprecation?: Entry['deprecation'];
  cost?: Entry['cost'];
  latencyHintMs?: number;
  examples?: Entry['examples'];
  input?: Entry['input'];
  keywords?: ListPatch<string> | string[];
  aliases?: ListPatch<string> | string[];
  /** `remove` matches by target (and type when given). */
  relations?: ListPatch<Relation | { target: string; type?: Relation['type'] }> | Relation[];
  extensions?: Record<string, unknown>;
}

export interface IndexOverlay {
  title?: string;
  summary?: string;
  sampleQueries?: ListPatch<string> | string[];
  examples?: ListPatch<string> | string[];
}

/** The entry key that patches every entry. */
export const WILDCARD = '*';

export interface Overlay {
  toolDictionaryOverlay: '0.1';
  dictionaryId: string;
  title?: string;
  summary?: string;
  defaults?: DictionaryDefaults;
  /** Merged with the generated map; overlay groups win on the same canonical term. */
  synonyms?: Record<string, string[]>;
  /** Keyed by entry name; the key `"*"` patches every entry and is applied first. */
  entries?: Record<string, EntryOverlay>;
  index?: Record<string, IndexOverlay>;
  /** New index nodes the generator did not produce (for grouping via entry `path` overrides). */
  addIndex?: IndexNode[];
  hide?: string[];
}

export interface OverlayIssue {
  at: string;
  message: string;
}

export interface OverlayResult {
  dictionary: Dictionary;
  /** Non-fatal: overlay keys naming things that no longer exist (spec 15.2). */
  issues: OverlayIssue[];
}

export class OverlayError extends Error {}

function patchList<T>(current: T[] | undefined, patch: ListPatch<T> | T[] | undefined, same: (a: T, b: T) => boolean): T[] | undefined {
  if (patch === undefined) return current;
  if (Array.isArray(patch)) return dedupe(patch, same);
  let out = [...(current ?? [])];
  for (const r of patch.remove ?? []) out = out.filter((c) => !same(c, r));
  for (const a of patch.add ?? []) if (!out.some((c) => same(c, a))) out.push(a);
  return dedupe(out, same);
}

function dedupe<T>(list: T[], same: (a: T, b: T) => boolean): T[] {
  const out: T[] = [];
  for (const item of list) if (!out.some((o) => same(o, item))) out.push(item);
  return out;
}

const sameString = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameRelation = (a: { target: string; type?: string }, b: { target: string; type?: string }) => a.target === b.target && (a.type === undefined || b.type === undefined || a.type === b.type);

function isOverlay(value: unknown): value is Overlay {
  return !!value && typeof value === 'object' && (value as Overlay).toolDictionaryOverlay === '0.1' && typeof (value as Overlay).dictionaryId === 'string';
}

export function applyOverlay(generated: Dictionary, rawOverlay: unknown): OverlayResult {
  if (!isOverlay(rawOverlay)) throw new OverlayError('not a Tool Dictionary overlay 0.1 (needs toolDictionaryOverlay and dictionaryId)');
  const overlay = rawOverlay;
  if (overlay.dictionaryId !== generated.id) {
    throw new OverlayError(`overlay is for dictionary "${overlay.dictionaryId}", generated dictionary is "${generated.id}"`);
  }
  const issues: OverlayIssue[] = [];
  const dictionary: Dictionary = JSON.parse(JSON.stringify(generated)) as Dictionary;

  if (overlay.title !== undefined) dictionary.title = overlay.title;
  if (overlay.summary !== undefined) dictionary.summary = overlay.summary;
  if (overlay.defaults) dictionary.defaults = { ...(dictionary.defaults ?? {}), ...overlay.defaults };
  if (overlay.synonyms) dictionary.synonyms = { ...(dictionary.synonyms ?? {}), ...overlay.synonyms };

  // New index nodes first, so entry path overrides can point at them.
  for (const node of overlay.addIndex ?? []) {
    const segments = node.path.split('/');
    if (segments.length === 1) dictionary.index.nodes.push(node);
    else {
      const parentPath = segments.slice(0, -1).join('/');
      const parent = flattenNodes(dictionary.index.nodes).find((n) => n.path === parentPath);
      if (!parent) {
        issues.push({ at: `addIndex "${node.path}"`, message: `parent node "${parentPath}" does not exist` });
        continue;
      }
      parent.children = [...(parent.children ?? []), node];
    }
  }

  const byName = new Map(dictionary.entries.map((e) => [e.name, e]));
  const applyEntryPatch = (entry: Entry, patch: EntryOverlay, at: string) => {
    for (const key of ['title', 'summary', 'description', 'path', 'returns', 'risk', 'stability', 'deprecation', 'cost', 'latencyHintMs', 'examples', 'input', 'extensions'] as const) {
      if (patch[key] !== undefined) (entry as unknown as Record<string, unknown>)[key] = patch[key];
    }
    const keywords = patchList(entry.keywords, patch.keywords, sameString);
    if (keywords !== undefined) entry.keywords = keywords;
    const aliases = patchList(entry.aliases, patch.aliases, sameString);
    if (aliases !== undefined) entry.aliases = aliases;
    if (patch.relations !== undefined) {
      // An added relation replaces whatever the generator guessed about the same
      // target: the author writing `broader` means that instead of the seeded
      // `pairs_with`, not next to it, and two relations to one target render as
      // the same tool twice.
      const added = Array.isArray(patch.relations) ? patch.relations : (patch.relations.add ?? []);
      const supersededTargets = new Set(added.map((r) => r.target));
      const current = entry.relations?.filter((r) => !supersededTargets.has(r.target));
      const relations = patchList<Relation | { target: string; type?: Relation['type'] }>(current, patch.relations, sameRelation);
      entry.relations = (relations ?? []).filter((r): r is Relation => 'type' in r && typeof (r as Relation).reason === 'string');
      const dropped = (relations ?? []).length - entry.relations.length;
      if (dropped) issues.push({ at: `${at}.relations`, message: `${dropped} added relation(s) lack type or reason and were ignored` });
    }
  };

  // `"*"` patches every entry, and runs first so a named patch can still
  // override it. Without it, a catalog-wide edit — dropping the keyword that the
  // generator put on all 500 entries, marking a whole surface `beta` — is 500
  // copies of the same three lines, and nobody keeps that honest.
  const wildcard = overlay.entries?.[WILDCARD];
  if (wildcard) for (const entry of dictionary.entries) applyEntryPatch(entry, wildcard, `entries "${WILDCARD}"`);
  for (const [name, patch] of Object.entries(overlay.entries ?? {})) {
    if (name === WILDCARD) continue;
    const entry = byName.get(name);
    if (!entry) {
      issues.push({ at: `entries "${name}"`, message: 'no generated entry with this name — an upstream rename or removal?' });
      continue;
    }
    applyEntryPatch(entry, patch, `entries "${name}"`);
  }

  const nodes = flattenNodes(dictionary.index.nodes);
  // A node listed in addIndex was written by hand in full; so was any field an
  // index patch set. Everything else is derived and gets re-derived below.
  const authored = {
    sampleQueries: new Set((overlay.addIndex ?? []).filter((n) => n.sampleQueries).map((n) => n.path)),
    examples: new Set((overlay.addIndex ?? []).filter((n) => n.examples).map((n) => n.path)),
  };
  for (const [path, patch] of Object.entries(overlay.index ?? {})) {
    const node = nodes.find((n) => n.path === path);
    if (!node) {
      issues.push({ at: `index "${path}"`, message: 'no generated index node at this path' });
      continue;
    }
    if (patch.title !== undefined) node.title = patch.title;
    if (patch.summary !== undefined) node.summary = patch.summary;
    // `patchList` returns the current list unchanged when there is no patch, so
    // what marks a field as the author's is the patch key being present.
    const sampleQueries = patchList(node.sampleQueries, patch.sampleQueries, sameString);
    if (sampleQueries !== undefined) node.sampleQueries = sampleQueries;
    if (patch.sampleQueries !== undefined) authored.sampleQueries.add(path);
    const examples = patchList(node.examples, patch.examples, (a, b) => a === b);
    if (examples !== undefined) node.examples = examples;
    if (patch.examples !== undefined) authored.examples.add(path);
  }

  const hide = new Set(overlay.hide ?? []);
  for (const name of hide) if (!byName.has(name)) issues.push({ at: `hide "${name}"`, message: 'no generated entry with this name' });
  if (hide.size) {
    dictionary.entries = dictionary.entries.filter((e) => !hide.has(e.name));
    for (const entry of dictionary.entries) {
      if (entry.relations) entry.relations = entry.relations.filter((r) => !hide.has(r.target));
      if (entry.deprecation?.replacedBy && hide.has(entry.deprecation.replacedBy)) delete entry.deprecation.replacedBy;
    }
    for (const node of nodes) if (node.examples) node.examples = node.examples.filter((n) => !hide.has(n));
  }

  // Entry paths may have moved and entries may be gone, so the index listings
  // the generator derived are stale. Re-derive the derived ones; leave the
  // authored ones alone. Nodes added by the overlay are included, so a new node
  // an entry was moved into does not have to have its examples written out.
  seedNodeListings(flattenNodes(dictionary.index.nodes), dictionary.entries, authored);

  dictionary.sources = [...(dictionary.sources ?? []), { type: 'overlay', url: overlaySourceUrl(overlay), fetchedAt: dictionary.generatedAt }];
  return { dictionary, issues };
}

function overlaySourceUrl(overlay: Overlay): string {
  return (overlay as { $source?: string }).$source ?? `overlay:${overlay.dictionaryId}`;
}
