/**
 * The agent-facing surface (spec 14), served rather than copied out of the
 * spec: the tool declarations with their endpoints filled in, and the system
 * prompt paragraph that tells a model when to search. A consumer that runs
 * several dictionaries fetches this once per dictionary and pastes.
 */
import type { AgentBundle, AgentTool } from './types';

export interface DictionaryDescription {
  id: string;
  title: string;
  summary: string;
}

const LIMIT_DESCRIPTION = 'How many tools to return. Default 8, max 50.';

/** The canonical `search_tools` declaration (spec 14) and the optional `list_tools` (spec 14.1). */
export function agentTools(baseUrl: string, dictionaryId: string): AgentTool[] {
  const root = `${baseUrl.replace(/\/+$/, '')}/v1/dictionaries/${encodeURIComponent(dictionaryId)}`;
  return [
    {
      name: 'search_tools',
      description:
        'Find the API tools that can answer the current question. Search with the words the user used — plain language works better than technical names. You get back a few matching tools with their inputs and the endpoint to call, plus related tools that answer nearby questions. If nothing matches, you get the catalogue of what this dictionary covers, with example searches; search again with one of those.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for, in plain language. Empty to see the catalogue.' },
          limit: { type: 'integer', description: LIMIT_DESCRIPTION, minimum: 1, maximum: 50 },
          path: { type: 'string', description: 'Optional category path from the catalogue, e.g. "tokens/holders", to search only inside it.' },
        },
        required: ['query'],
      },
      endpoint: `${root}/search`,
      method: 'POST',
    },
    {
      name: 'list_tools',
      description:
        'List every tool in this dictionary as one line each: name and title. Use it when you want the complete picture rather than a search, or to pick a name to look up. Pass a category path to list only that part.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional category path, e.g. "tokens", to list only that subtree.' },
        },
      },
      endpoint: `${root}/entries`,
      method: 'GET',
    },
  ];
}

/** Spec 14.2, with the dictionary's own summary filled in. */
export function systemPrompt(dictionary: DictionaryDescription): string {
  return (
    `You have access to a tool dictionary covering ${dictionary.summary.trim().replace(/\.$/, '')}. ` +
    'When a question needs data you do not have, search it before answering. Search with the user\'s own words. ' +
    'Read the "see also" lines: they frequently name the tool you actually wanted. ' +
    'If you would rather see everything at once, list the tools; each line is a name you can search for exactly.'
  );
}

/**
 * One paragraph for a consumer that fronts several dictionaries: names each so
 * the model can pick, then the same guidance. Empty list ⇒ says so, never an
 * empty string a prompt would silently swallow.
 */
export function usagePrompt(dictionaries: DictionaryDescription[]): string {
  if (dictionaries.length === 0) return 'No tool dictionaries are available right now.';
  if (dictionaries.length === 1) return systemPrompt(dictionaries[0]!);
  const lines = dictionaries.map((d) => `- ${d.id}: ${d.title} — ${d.summary.trim()}`);
  return (
    `You have access to ${dictionaries.length} tool dictionaries:\n${lines.join('\n')}\n` +
    'When a question needs data you do not have, pick the dictionary whose summary fits and search it before answering. ' +
    'Search with the user\'s own words. Read the "see also" lines: they frequently name the tool you actually wanted. ' +
    'If you would rather see everything a dictionary offers, list its tools; each line is a name you can search for exactly.'
  );
}

export function agentBundle(baseUrl: string, dictionary: AgentBundle['dictionary']): AgentBundle {
  return { dictionary, tools: agentTools(baseUrl, dictionary.id), systemPrompt: systemPrompt(dictionary) };
}
