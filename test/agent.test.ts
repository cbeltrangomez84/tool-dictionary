import { describe, expect, it } from 'vitest';
import { agentTools, systemPrompt, usagePrompt } from '../src/agent';

describe('agent bundle (spec 14)', () => {
  it('fills endpoints from the base URL and encodes the id', () => {
    const tools = agentTools('https://dict.example.com///', 'crypto data');
    expect(tools.map((t) => [t.name, t.method, t.endpoint])).toEqual([
      ['search_tools', 'POST', 'https://dict.example.com/v1/dictionaries/crypto%20data/search'],
      ['list_tools', 'GET', 'https://dict.example.com/v1/dictionaries/crypto%20data/entries'],
    ]);
    expect(tools[0]!.input_schema).toMatchObject({ type: 'object', required: ['query'] });
    expect(Object.keys((tools[0]!.input_schema as { properties: object }).properties)).toEqual(['query', 'limit', 'path', 'dictionary']);
    expect(tools[1]!.input_schema).toMatchObject({ type: 'object' });
  });

  it('declares execute_tool only when execution is on (spec 14.5)', () => {
    const off = agentTools('https://dict.example.com', 'crypto-data');
    expect(off.map((t) => t.name)).toEqual(['search_tools', 'list_tools']);
    expect(off[0]!.description).toContain('the endpoint to call');

    const on = agentTools('https://dict.example.com', 'crypto-data', { execute: true });
    expect(on.map((t) => [t.name, t.method, t.endpoint])).toEqual([
      ['search_tools', 'POST', 'https://dict.example.com/v1/dictionaries/crypto-data/search'],
      ['list_tools', 'GET', 'https://dict.example.com/v1/dictionaries/crypto-data/entries'],
      ['execute_tool', 'POST', 'https://dict.example.com/v1/dictionaries/crypto-data/execute'],
    ]);
    const execute = on[2]!.input_schema as { required: string[]; properties: Record<string, { type: string }> };
    expect(execute.required).toEqual(['name', 'params']);
    expect(execute.properties.name!.type).toBe('string');
    expect(execute.properties.params!.type).toBe('object');
    expect(execute.properties.dictionary!.type).toBe('string');
    // The search description stops pointing the model at endpoints once it can execute by name.
    expect(on[0]!.description).not.toContain('the endpoint to call');
    expect(on[0]!.description).toContain('execute_tool');
  });

  it('adds the execute loop to the prompts only when execution is on', () => {
    const one = { id: 'crypto-data', title: 'Crypto data', summary: 'Token holders.' };
    expect(systemPrompt(one)).not.toContain('execute_tool');
    expect(systemPrompt(one, { execute: true })).toContain('execute_tool');
    expect(systemPrompt(one, { execute: true })).toContain('never need a URL or a key');
    const two = [one, { id: 'nft', title: 'NFT', summary: 'Collections.' }];
    expect(usagePrompt(two)).not.toContain('execute_tool');
    expect(usagePrompt(two, { execute: true })).toContain('Name the dictionary in every call');
  });

  it('builds the single-dictionary prompt without a double period', () => {
    const text = systemPrompt({ id: 'crypto-data', title: 'Crypto data', summary: 'Token holders, prices and wallet PnL.' });
    expect(text.startsWith('You have access to a tool dictionary covering Token holders, prices and wallet PnL. When')).toBe(true);
  });

  it('names every dictionary when there are several, and never returns an empty prompt', () => {
    const several = usagePrompt([
      { id: 'a', title: 'A', summary: 'Alpha things.' },
      { id: 'b', title: 'B', summary: 'Beta things.' },
    ]);
    expect(several).toContain('2 tool dictionaries:\n- a: A — Alpha things.\n- b: B — Beta things.\n');
    expect(usagePrompt([{ id: 'a', title: 'A', summary: 'Alpha things.' }])).toBe(systemPrompt({ id: 'a', title: 'A', summary: 'Alpha things.' }));
    expect(usagePrompt([])).toBe('No tool dictionaries are available right now.');
  });
});
