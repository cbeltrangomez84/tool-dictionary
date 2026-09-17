/**
 * The agent-facing surface (spec 14), served rather than copied out of the
 * spec: the tool declarations with their endpoints filled in, and the system
 * prompt paragraph that tells a model when to search. A consumer that runs
 * several dictionaries fetches this once per dictionary and pastes.
 *
 * `execute_tool` (spec 14.5) appears only when the deployment executes that
 * dictionary: a declared tool that always answers 403 would teach the model
 * the wrong loop.
 */
import type { AgentBundle, AgentTool } from './types';

export interface DictionaryDescription {
  id: string;
  title: string;
  summary: string;
}

export interface AgentOptions {
  /** Declare `execute_tool` and describe the execute loop in the prompt. */
  execute?: boolean;
}

const LIMIT_DESCRIPTION = 'How many tools to return. Default 8, max 50.';
const DICTIONARY_DESCRIPTION = 'Optional dictionary id. Only needed when several dictionaries are available; when given it must be the one this endpoint serves.';

/** The canonical `search_tools` declaration (spec 14), the optional `list_tools` (14.1) and, when enabled, `execute_tool` (14.5). */
export function agentTools(baseUrl: string, dictionaryId: string, options: AgentOptions = {}): AgentTool[] {
  const root = `${baseUrl.replace(/\/+$/, '')}/v1/dictionaries/${encodeURIComponent(dictionaryId)}`;
  const tools: AgentTool[] = [
    {
      name: 'search_tools',
      description:
        'Find the API tools that can answer the current question. Search with the words the user used — plain language works better than technical names. You get back a few matching tools with their inputs' +
        (options.execute ? ' — pass those to execute_tool by name —' : ' and the endpoint to call,') +
        ' plus related tools that answer nearby questions. If nothing matches, you get the catalogue of what this dictionary covers, with example searches; search again with one of those.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for, in plain language. Empty to see the catalogue.' },
          limit: { type: 'integer', description: LIMIT_DESCRIPTION, minimum: 1, maximum: 50 },
          path: { type: 'string', description: 'Optional category path from the catalogue, e.g. "tokens/holders", to search only inside it.' },
          dictionary: { type: 'string', description: DICTIONARY_DESCRIPTION },
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
  if (options.execute) {
    tools.push({
      name: 'execute_tool',
      description:
        'Run one tool from this dictionary by name and get its result. Use the exact "name" a search returned and give "params" matching that tool\'s inputs. The result is the API\'s own answer (JSON when it is JSON), cut to a size budget when large; "truncated" tells you when it was. Errors name the input or credential that was missing.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The tool name exactly as search_tools or list_tools returned it.' },
          params: { type: 'object', description: 'The tool\'s inputs, keyed as its input schema names them. Omit inputs that are optional and unknown.' },
          dictionary: { type: 'string', description: DICTIONARY_DESCRIPTION },
        },
        required: ['name', 'params'],
      },
      endpoint: `${root}/execute`,
      method: 'POST',
    });
  }
  return tools;
}

/** Spec 14.2, with the dictionary's own summary filled in. */
export function systemPrompt(dictionary: DictionaryDescription, options: AgentOptions = {}): string {
  return (
    `You have access to a tool dictionary covering ${dictionary.summary.trim().replace(/\.$/, '')}. ` +
    'When a question needs data you do not have, search it before answering. Search with the user\'s own words. ' +
    'Read the "see also" lines: they frequently name the tool you actually wanted. ' +
    'If you would rather see everything at once, list the tools; each line is a name you can search for exactly.' +
    (options.execute ? ' ' + EXECUTE_GUIDANCE : '')
  );
}

const EXECUTE_GUIDANCE =
  'Once a search shows the tool you need, run it with execute_tool: pass its exact name and the inputs its schema lists — you never need a URL or a key. ' +
  'If the result says it was truncated, ask for less (narrower inputs, a smaller page) rather than assuming the rest. ' +
  'If it reports a missing input, search again or read the tool\'s inputs before retrying.';

/**
 * One paragraph for a consumer that fronts several dictionaries: names each so
 * the model can pick, then the same guidance. Empty list ⇒ says so, never an
 * empty string a prompt would silently swallow.
 */
export function usagePrompt(dictionaries: DictionaryDescription[], options: AgentOptions = {}): string {
  if (dictionaries.length === 0) return 'No tool dictionaries are available right now.';
  if (dictionaries.length === 1) return systemPrompt(dictionaries[0]!, options);
  const lines = dictionaries.map((d) => `- ${d.id}: ${d.title} — ${d.summary.trim()}`);
  return (
    `You have access to ${dictionaries.length} tool dictionaries:\n${lines.join('\n')}\n` +
    'When a question needs data you do not have, pick the dictionary whose summary fits and search it before answering. ' +
    'Search with the user\'s own words. Read the "see also" lines: they frequently name the tool you actually wanted. ' +
    'If you would rather see everything a dictionary offers, list its tools; each line is a name you can search for exactly.' +
    (options.execute ? ' ' + EXECUTE_GUIDANCE + ' Name the dictionary in every call when more than one could apply.' : '')
  );
}

export function agentBundle(baseUrl: string, dictionary: AgentBundle['dictionary'], options: AgentOptions = {}): AgentBundle {
  return {
    dictionary,
    tools: agentTools(baseUrl, dictionary.id, options),
    systemPrompt: systemPrompt(dictionary, options),
    execute: options.execute === true,
  };
}
