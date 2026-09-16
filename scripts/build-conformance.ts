/**
 * Regenerates the text-rendering conformance vectors in `conformance/text/`.
 *
 * The vectors are the contract a consumer asserts against (spec 11.4), so they
 * are produced by the reference service itself and checked in. `npm test` fails
 * when the checked-in bytes and the current renderer disagree; regenerating is
 * therefore a deliberate act that shows up as a reviewable diff.
 *
 * Run: npm run conformance
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DictionaryService } from '../src/service';
import { renderIndexText } from '../src/render/text';
import type { Dictionary, IndexResponse, SearchRequest } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'conformance', 'text');

const read = (p: string): Dictionary => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8')) as Dictionary;

interface Case {
  slug: string;
  covers: string;
  dictionary: string;
  request: SearchRequest;
}

const CASES: Case[] = [
  {
    slug: '01-results-auto',
    covers: 'The common case: auto detail, rank 1-3 at full, a related section, no notice.',
    dictionary: 'crypto-data',
    request: { query: 'how many people hold this token' },
  },
  {
    slug: '02-results-degraded',
    covers: 'A budget too small for the whole page: NOTE line, reduced detail, MORE cursor line.',
    dictionary: 'crypto-data',
    request: { query: 'holders', maxBytes: 1400 },
  },
  {
    slug: '03-results-single-summary',
    covers: 'Singular "1 result", explicit summary detail, related suppressed.',
    dictionary: 'crypto-data',
    request: { query: 'market cap', limit: 1, detail: 'summary', includeRelated: false },
  },
  {
    slug: '04-results-risk-and-deprecation',
    covers: 'BETA, DEPRECATED and RISK lines; enum/default/required facets; examples with and without a note.',
    dictionary: 'vectors',
    request: { query: 'alert' },
  },
  {
    slug: '05-results-mcp-and-local',
    covers: 'MCP and local call rendering, and a tool that takes no input.',
    dictionary: 'vectors',
    request: { query: 'probe echo debug' },
  },
  {
    slug: '06-index-empty-query',
    covers: 'Empty query returns the index: NOTE, CATEGORIES, nesting, try/e.g. lines.',
    dictionary: 'vectors',
    request: { query: '' },
  },
  {
    slug: '07-index-below-threshold',
    covers: 'A miss returns the index with a DID YOU MEAN section.',
    dictionary: 'crypto-data',
    request: { query: 'holdrs of a tokn' },
  },
];

/**
 * Hand-authored rather than served: a degraded node only appears when a branch
 * fails to load, and a vector must not depend on a network failure to reproduce.
 */
const DEGRADED: { slug: string; covers: string; response: IndexResponse } = {
  slug: '08-index-degraded-branch',
  covers: 'A branch that failed to load renders as [unavailable] instead of disappearing.',
  response: {
    kind: 'index',
    dictionary: { id: 'crypto-data', version: 47, etag: '"sha256:0000000000000000000000000000000000000000000000000000000000000000"' },
    query: { text: '' },
    reason: 'empty_query',
    notice: 'One branch is unavailable; its tools are not searchable right now.',
    suggestions: [],
    index: {
      nodes: [
        {
          path: 'tokens',
          title: 'Tokens',
          summary: 'Everything keyed by a token address.',
          entryCount: 6,
          sampleQueries: ['price of a token'],
          children: [
            { path: 'tokens/holders', title: 'Holders', summary: 'Who holds a token and how much.', entryCount: 3 },
          ],
        },
        {
          path: 'nfts',
          title: 'NFTs',
          summary: 'Collections, floors and owners.',
          entryCount: 0,
          degraded: true,
        },
      ],
    },
    budget: { maxBytes: 16000, usedBytes: 0, truncated: false },
  },
};

async function main(): Promise<void> {
  const service = new DictionaryService();
  await service.install({ source: { kind: 'inline' } }, read('spec/examples/crypto-data.dictionary.json'));
  await service.install({ source: { kind: 'inline' } }, read('conformance/fixtures/vectors.dictionary.json'));

  const manifest: { slug: string; covers: string; dictionary: string; request: unknown; kind: string; bytes: number }[] = [];

  for (const c of CASES) {
    const json = await service.search(c.dictionary, { ...c.request, format: 'json' });
    const text = await service.search(c.dictionary, { ...c.request, format: 'text' });
    const meta = {
      case: c.slug,
      covers: c.covers,
      dictionary: c.dictionary,
      request: c.request,
      response: json.response,
    };
    writeFileSync(path.join(OUT, `${c.slug}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    writeFileSync(path.join(OUT, `${c.slug}.txt`), text.body);
    manifest.push({ slug: c.slug, covers: c.covers, dictionary: c.dictionary, request: c.request, kind: json.response.kind, bytes: Buffer.byteLength(text.body, 'utf8') });
    process.stdout.write(`${c.slug}: ${json.response.kind}, ${Buffer.byteLength(text.body, 'utf8')} bytes\n`);
  }

  const degradedText = renderIndexText(DEGRADED.response);
  writeFileSync(
    path.join(OUT, `${DEGRADED.slug}.json`),
    `${JSON.stringify({ case: DEGRADED.slug, covers: DEGRADED.covers, dictionary: 'crypto-data', request: null, response: DEGRADED.response }, null, 2)}\n`,
  );
  writeFileSync(path.join(OUT, `${DEGRADED.slug}.txt`), degradedText);
  manifest.push({ slug: DEGRADED.slug, covers: DEGRADED.covers, dictionary: 'crypto-data', request: null, kind: 'index', bytes: Buffer.byteLength(degradedText, 'utf8') });
  process.stdout.write(`${DEGRADED.slug}: index, ${Buffer.byteLength(degradedText, 'utf8')} bytes\n`);

  writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify({ toolDictionary: '0.1', section: '11.4', cases: manifest }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
