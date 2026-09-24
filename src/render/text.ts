/**
 * The normative plain-text rendering (spec 11.4).
 *
 * A consumer that pastes the raw tool result into a prompt pays for every brace
 * and quoted key in JSON. This form carries the same decisions in roughly 40%
 * fewer tokens. The layout is fixed to the byte by spec 11.4 — a consumer is
 * expected to assert on it — so every change here is a change to the spec and to
 * the conformance vectors in `conformance/text/`.
 *
 * Two invariants worth stating out loud: the closing instruction is always
 * emitted, because it is the only place the agent is told what to do next; and
 * an empty section is omitted entirely rather than rendered as a bare heading.
 */
import type { Auth, EntriesResponse, HttpCall, IndexNode, IndexResponse, JsonSchema, RenderedEntry, ResultsResponse } from '../types';

/** One indent unit: three spaces (spec 11.4). */
const IND = '   ';
/** Continuation of the `input:` block, aligned under the first property. */
const INPUT_CONT = `${IND}       `;
/** Continuation of a `RELATED` item, aligned under its `- ` bullet. */
const REL_CONT = `${IND}  `;

function describeInput(schema: JsonSchema | undefined): string[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const bits: string[] = [];
    if (typeof prop.type === 'string') bits.push(prop.type);
    if (Array.isArray(prop.enum)) bits.push(`one of ${prop.enum.join('|')}`);
    if (required.has(name)) bits.push('required');
    if (prop.default !== undefined) bits.push(`default ${JSON.stringify(prop.default)}`);
    const desc = typeof prop.description === 'string' ? ` — ${prop.description}` : '';
    lines.push(`${name} (${bits.join(', ')})${desc}`);
  }
  return lines.length ? lines : ['(takes no input)'];
}

/** The hint when the author wrote one, else the placement, else the bare fact (spec 11.4). */
function describeAuth(auth: Auth): string {
  if (auth.hint) return auth.hint;
  if (auth.in && auth.name) return `${auth.name} ${auth.in}`;
  return 'supplied by caller';
}

function describeCall(entry: RenderedEntry): string | undefined {
  const call = entry.call;
  if (!call) return undefined;
  if (call.type === 'mcp') return `MCP ${call.server} :: ${call.tool}`;
  if (call.type === 'local') return `local handler ${call.handler}`;
  const http = call as HttpCall;
  const query = Object.entries(http.query ?? {});
  const qs = query.length ? `?${query.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  const auth = http.auth?.kind === 'caller' ? `  (auth: ${describeAuth(http.auth)})` : '';
  return `${http.method} ${http.baseUrl ?? ''}${http.urlTemplate}${qs}${auth}`;
}

function renderResult(entry: RenderedEntry, n: number): string[] {
  const lines = [`${n}. ${entry.name} — ${entry.title}`];
  if (entry.summary) lines.push(`${IND}${entry.summary}`);
  // Warnings before facts: whatever makes this tool the wrong choice should be
  // read before the model has finished reading how to call it.
  if (entry.stability === 'deprecated') lines.push(`${IND}DEPRECATED`);
  else if (entry.stability === 'beta') lines.push(`${IND}BETA`);
  if (entry.risk && entry.risk !== 'read') lines.push(`${IND}RISK: ${entry.risk}`);
  if (entry.briefOf) lines.push(`${IND}BRIEF of ${entry.briefOf}: the same answer in a compact response; prefer this one`);
  if (entry.brief) lines.push(`${IND}BRIEF: ${entry.brief} answers this compactly; prefer it unless you need the full data`);
  if (entry.path) lines.push(`${IND}path: ${entry.path}`);
  if (entry.detail === 'full') {
    if (entry.description) lines.push(`${IND}${entry.description}`);
    const input = describeInput(entry.input);
    lines.push(`${IND}input: ${input[0]}`);
    for (const line of input.slice(1)) lines.push(`${INPUT_CONT}${line}`);
    if (entry.returns) lines.push(`${IND}returns: ${entry.returns}`);
    const call = describeCall(entry);
    if (call) lines.push(`${IND}call: ${call}`);
    if (entry.cost?.tier) lines.push(`${IND}cost: ${entry.cost.tier}${entry.cost.note ? ` — ${entry.cost.note}` : ''}`);
    for (const ex of entry.examples ?? []) {
      lines.push(`${IND}example: ${JSON.stringify(ex.input)}${ex.note ? `  (${ex.note})` : ''}`);
    }
  }
  for (const rel of entry.relations ?? []) {
    lines.push(`${IND}see also: ${rel.target} (${rel.type}) — ${rel.reason}`);
  }
  return lines;
}

export const TEXT_FOOTER =
  'To use one, call it with the input shown. To see the full definition of any of\nthese, search again with its exact name.';

export function renderResultsText(response: ResultsResponse): string {
  const out: string[] = [];
  const n = response.results.length;
  out.push(`DICTIONARY ${response.dictionary.id} v${response.dictionary.version} — ${n} result${n === 1 ? '' : 's'} for ${JSON.stringify(response.query.text)}`);
  if (response.notice) out.push(`NOTE: ${response.notice}`);
  out.push('');
  response.results.forEach((entry, i) => {
    out.push(...renderResult(entry, i + 1), '');
  });
  if (response.related.length) {
    out.push('RELATED');
    for (const rel of response.related) {
      out.push(`${IND}- ${rel.name} — ${rel.title}`);
      if (rel.summary) out.push(`${REL_CONT}${rel.summary}`);
      if (rel.via) out.push(`${REL_CONT}(${rel.via.type} to ${rel.via.from}: ${rel.via.reason})`);
    }
    out.push('');
  }
  if (response.nextCursor) out.push(`MORE: pass cursor ${JSON.stringify(response.nextCursor)} to continue.`, '');
  out.push(TEXT_FOOTER);
  return out.join('\n');
}

function renderNode(node: IndexNode, depth: number, out: string[]): void {
  const pad = IND.repeat(depth);
  const count = node.entryCount !== undefined ? ` (${node.entryCount})` : '';
  const degraded = node.degraded ? ' [unavailable]' : '';
  out.push(`${pad}${node.path}${count}${degraded} — ${node.title}: ${node.summary}`);
  if (node.sampleQueries?.length) out.push(`${pad}${IND}try: ${node.sampleQueries.map((q) => JSON.stringify(q)).join(', ')}`);
  if (node.examples?.length) out.push(`${pad}${IND}e.g. ${node.examples.join(', ')}`);
  for (const child of node.children ?? []) renderNode(child, depth + 1, out);
}

export const INDEX_FOOTER = 'Search again with one of the "try" queries, or with a path to narrow to one branch.';

export function renderIndexText(response: IndexResponse): string {
  const out: string[] = [];
  out.push(`DICTIONARY ${response.dictionary.id} v${response.dictionary.version} — index`);
  out.push(`NOTE: ${response.notice}`);
  if (response.suggestions.length) {
    out.push('', 'DID YOU MEAN');
    for (const s of response.suggestions) out.push(`${IND}${s.name} — ${s.title}  (${s.why})`);
  }
  out.push('', 'CATEGORIES');
  for (const node of response.index.nodes) renderNode(node, 0, out);
  out.push('', INDEX_FOOTER);
  return out.join('\n');
}

/** One line per entry (spec 9.5): `name — title` under a heading naming the dictionary and scope. */
export function renderEntriesText(response: EntriesResponse): string {
  const scope = response.path ? ` under "${response.path}"` : '';
  const out: string[] = [`DICTIONARY ${response.dictionary.id} v${response.dictionary.version} — ${response.total} entr${response.total === 1 ? 'y' : 'ies'}${scope}`];
  for (const e of response.entries) out.push(`${e.name} — ${e.title}${e.risk ? ` [${e.risk}]` : ''}`);
  return out.join('\n') + '\n';
}
