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
    expect(Object.keys((tools[0]!.input_schema as { properties: object }).properties)).toEqual(['query', 'limit', 'path']);
    expect(tools[1]!.input_schema).toMatchObject({ type: 'object' });
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
