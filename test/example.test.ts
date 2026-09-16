/**
 * The worked example is a fixture, not a screenshot: `spec/examples/pool-scout`
 * is an OpenAPI document plus a hand-authored overlay, and the dictionary
 * checked in next to them must be exactly what the generator produces from
 * those two today.
 *
 * A diff here means the generator changed. Regenerate with `npm run example`,
 * read the diff — that is the point of the example — and commit it with the
 * change.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POOL_SCOUT_ARGV, EXAMPLE_FILE } from '../scripts/build-example';
import { run } from '../src/generate/cli';
import { DictionaryService } from '../src/service';
import { validateDictionary } from '../src/validate';
import type { Dictionary } from '../src/types';

const checkedIn = (): Dictionary => JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8')) as Dictionary;

describe('spec/examples/pool-scout', () => {
  it('is exactly what the generator produces from the OpenAPI document and the overlay', async () => {
    const { dictionary } = await run(POOL_SCOUT_ARGV, () => {});
    expect(JSON.stringify(dictionary, null, 2)).toBe(JSON.stringify(checkedIn(), null, 2));
  });

  it('records where its inputs live, not where they were built', () => {
    // A checked-in document that names the machine it was generated on is not
    // reproducible from another checkout, and leaks a path for no reason.
    for (const source of checkedIn().sources ?? []) expect(source.url).toMatch(/^https:\/\//);
  });

  it('is valid, and its only warnings are the three the README admits to', async () => {
    const { warnings, issues } = await run(POOL_SCOUT_ARGV, () => {});
    expect(issues).toEqual([]);
    // `chain` is on every tool because every tool takes it; `liquidity` and
    // `fee` are the subject matter. None of them discriminates and the search
    // knows it; keeping them means an agent holding a chain name or asking
    // about liquidity in general still lands somewhere sensible.
    expect(warnings.map((w) => w.message.replace(/"(\w+)".*/, '$1')).sort()).toEqual(['keyword chain', 'keyword fee', 'keyword liquidity']);
    expect(validateDictionary(checkedIn()).ok).toBe(true);
  });

  it('answers the questions a person actually asks about a pool', async () => {
    const service = new DictionaryService();
    await service.install({ source: { kind: 'inline' } }, checkedIn());
    const top = async (query: string): Promise<string | undefined> => {
      const built = await service.search('pool-scout', { query });
      return (JSON.parse(built.body) as { results?: { name: string }[] }).results?.[0]?.name;
    };
    // None of these words appear in the upstream document. They come from the
    // overlay, which is the whole claim being tested: the human knowledge is
    // what makes an OpenAPI document searchable in the words of the caller.
    expect(await top('is this pool a rug')).toBe('get_pools_liquidity');
    expect(await top('what would i earn providing liquidity')).toBe('get_pools_apr');
    expect(await top('who is buying')).toBe('get_pools_swaps');
    expect(await top('find the main pool for SOL')).toBe('get_pools_search');
    service.close();
  });

  it('keeps the index honest about where each tool lives', () => {
    const dictionary = checkedIn();
    const root = dictionary.index.nodes[0]!;
    const status = root.children?.[0];
    expect(status?.path).toBe('pools/status');
    // get_pools_health was moved into the child by the overlay, so the parent
    // must stop advertising it.
    expect(root.examples).not.toContain('get_pools_health');
    expect(status?.examples).toEqual(['get_pools_health']);
  });

  it('keeps the public health check free of the key every other tool needs', () => {
    const dictionary = checkedIn();
    expect(dictionary.defaults?.auth).toMatchObject({ kind: 'caller', in: 'header', name: 'x-scout-key', value: '{{POOL_SCOUT_API_KEY}}' });
    const health = dictionary.entries.find((e) => e.name === 'get_pools_health')!;
    expect(health.call).toMatchObject({ type: 'http', auth: { kind: 'none' } });
  });
});
