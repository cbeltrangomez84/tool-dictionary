/**
 * Rebuilds the worked example in spec/examples/pool-scout.
 *
 * The argument list lives here rather than in a README command block because it
 * is the one thing a reader must be able to trust: `test/example.test.ts`
 * regenerates with exactly this argv and asserts the checked-in document comes
 * back unchanged. A generator change that quietly improves the example is fine;
 * one that changes it without anybody noticing is not.
 *
 *   npm run example
 */
import path from 'node:path';
import { main } from '../src/generate/cli';

const ROOT = path.resolve(__dirname, '..');
export const EXAMPLE_DIR = path.join(ROOT, 'spec', 'examples', 'pool-scout');
export const EXAMPLE_FILE = path.join(EXAMPLE_DIR, 'pool-scout.dictionary.json');

/**
 * `--generated-at` is pinned so the output is a function of its inputs alone;
 * without it every run would differ and the example could not be a fixture.
 */
export const POOL_SCOUT_ARGV: string[] = [
  '--openapi',
  path.join(EXAMPLE_DIR, 'openapi.json'),
  '--overlay',
  path.join(EXAMPLE_DIR, 'overlay.json'),
  '--id',
  'pool-scout',
  '--generated-at',
  '2026-09-16T00:00:00.000Z',
  // `api` and `public` are routing: neither tells an agent anything, and both
  // would otherwise land in every name. `pools` is kept — it is the resource.
  '--strip-prefix',
  'api',
  '--strip-prefix',
  'public',
  // The document's own servers[0] is http://localhost:4020, which is true for
  // the service's test harness and useless to a caller.
  '--base-url',
  'https://api.poolscout.example',
  '--source-url',
  'https://api.poolscout.example/openapi.json',
  // Both sources are recorded as where a reader can fetch them, not as paths on
  // the machine that happened to run the build.
  '--overlay-url',
  'https://github.com/cbeltrangomez84/tool-dictionary/blob/main/spec/examples/pool-scout/overlay.json',
];

if (require.main === module) {
  main([...POOL_SCOUT_ARGV, '--out', EXAMPLE_FILE]).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`build-example: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
