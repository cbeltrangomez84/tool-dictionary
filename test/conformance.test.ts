/**
 * The text rendering is a contract (spec 11.4), so it is tested as one: the
 * checked-in vectors must come back byte for byte, both from the renderer given
 * a response and from the service given the original request.
 *
 * A diff here means the rendering changed. That is allowed — it is not allowed
 * to happen quietly. Regenerate with `npm run conformance`, review the diff, and
 * update spec 11.4 in the same commit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DictionaryService } from '../src/service';
import { renderIndexText, renderResultsText } from '../src/render/text';
import type { Dictionary, IndexResponse, ResultsResponse, SearchRequest } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const VECTORS = path.join(ROOT, 'conformance', 'text');

interface Vector {
  case: string;
  covers: string;
  dictionary: string;
  request: SearchRequest | null;
  response: ResultsResponse | IndexResponse;
}

const slugs = readdirSync(VECTORS)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => f.replace(/\.txt$/, ''))
  .sort();

const load = (slug: string): { vector: Vector; text: string } => ({
  vector: JSON.parse(readFileSync(path.join(VECTORS, `${slug}.json`), 'utf8')) as Vector,
  text: readFileSync(path.join(VECTORS, `${slug}.txt`), 'utf8'),
});

const dictionary = (p: string): Dictionary => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8')) as Dictionary;

async function service(): Promise<DictionaryService> {
  const s = new DictionaryService();
  await s.install({ source: { kind: 'inline' } }, dictionary('spec/examples/crypto-data.dictionary.json'));
  await s.install({ source: { kind: 'inline' } }, dictionary('conformance/fixtures/vectors.dictionary.json'));
  return s;
}

describe('text conformance vectors', () => {
  it('ships vectors for both response kinds', () => {
    expect(slugs.length).toBeGreaterThanOrEqual(8);
    const kinds = slugs.map((s) => load(s).vector.response.kind);
    expect(kinds).toContain('results');
    expect(kinds).toContain('index');
  });

  it.each(slugs)('%s renders to exactly the checked-in bytes', (slug) => {
    const { vector, text } = load(slug);
    const rendered = vector.response.kind === 'results' ? renderResultsText(vector.response) : renderIndexText(vector.response);
    expect(rendered).toBe(text);
  });

  it.each(slugs)('%s is reproducible end to end from its request', async (slug) => {
    const { vector, text } = load(slug);
    if (!vector.request) return; // hand-authored response; the renderer test above covers it
    const s = await service();
    const built = await s.search(vector.dictionary, { ...vector.request, format: 'text' });
    expect(built.body).toBe(text);
  });

  it('holds the invariants a consumer is allowed to rely on', () => {
    for (const slug of slugs) {
      const { vector, text } = load(slug);
      const where = `${slug}: `;
      // Line endings, and no trailing newline: the last byte is the last byte of the footer.
      expect(where + String(text.includes('\r'))).toBe(`${where}false`);
      expect(where + String(text.endsWith('\n'))).toBe(`${where}false`);
      expect(where + text.split('\n')[0]!.slice(0, 11)).toBe(`${where}DICTIONARY `);
      // The closing instruction is always present; it is the only place the
      // agent is told what to do next.
      const footer = vector.response.kind === 'results' ? 'search again with its exact name.' : 'or with a path to narrow to one branch.';
      expect(where + String(text.endsWith(footer))).toBe(`${where}true`);
      // No heading is ever emitted empty.
      for (const heading of ['RELATED', 'CATEGORIES', 'DID YOU MEAN']) {
        const at = text.split('\n').indexOf(heading);
        if (at !== -1) expect(where + (text.split('\n')[at + 1] ?? '')).not.toBe(`${where}`);
      }
    }
  });

  it('costs meaningfully fewer bytes than the same response as JSON', () => {
    for (const slug of slugs) {
      const { vector, text } = load(slug);
      const json = JSON.stringify(vector.response);
      expect(`${slug}: ${Buffer.byteLength(text) < Buffer.byteLength(json)}`).toBe(`${slug}: true`);
    }
  });
});
