import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, main, parseArgs, run } from '../src/generate/cli';
import type { Dictionary } from '../src/types';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const OPENAPI = path.join(FIXTURES, 'sample-openapi.json');
const OVERLAY = path.join(FIXTURES, 'sample-overlay.json');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'td-gen-'));
const base = ['--openapi', OPENAPI, '--id', 'sample', '--generated-at', '2026-09-15T00:00:00.000Z'];

afterEach(() => vi.restoreAllMocks());

describe('parseArgs', () => {
  it('accepts --flag value and --flag=value, and repeats --strip-prefix', () => {
    const args = parseArgs(['--openapi', 'a.json', '--id=sample', '--strip-prefix', 'v1', '--strip-prefix=api', '--strict']);
    expect(args.openapi).toBe('a.json');
    expect(args.id).toBe('sample');
    expect(args.stripPrefix).toEqual(['v1', 'api']);
    expect(args.strict).toBe(true);
  });

  it('rejects unknown options and missing values', () => {
    expect(() => parseArgs(['--nope', 'x'])).toThrow(CliError);
    expect(() => parseArgs(['--openapi', '--id', 'x'])).toThrow(/needs a value/);
  });
});

describe('run', () => {
  it('generates a validated dictionary from a file', async () => {
    const result = await run(base, () => {});
    expect(result.dictionary.id).toBe('sample');
    expect(result.dictionary.version).toBe(1);
    expect(result.dictionary.entries.length).toBeGreaterThan(5);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);
  });

  it('applies an overlay and reports its stale keys', async () => {
    const result = await run([...base, '--overlay', OVERLAY], () => {});
    expect(result.dictionary.entries.find((e) => e.name === 'holders_count')?.aliases).toEqual(['token_holders']);
    expect(result.issues.length).toBe(3);
    expect(result.dictionary.sources?.some((s) => s.type === 'overlay' && s.url.endsWith('sample-overlay.json'))).toBe(true);
  });

  it('keeps the version when the content did not change and bumps it when it did', async () => {
    const dir = tmp();
    const first = await run(base, () => {});
    const previousPath = path.join(dir, 'previous.json');
    const previous = { ...first.dictionary, version: 7 };
    writeFileSync(previousPath, JSON.stringify(previous));

    const unchanged = await run([...base, '--previous', previousPath], () => {});
    expect(unchanged.dictionary.version).toBe(7);
    expect(unchanged.changed).toBe(false);

    // A different generated-at alone must NOT count as a change.
    const laterStamp = await run(['--openapi', OPENAPI, '--id', 'sample', '--generated-at', '2027-01-01T00:00:00.000Z', '--previous', previousPath], () => {});
    expect(laterStamp.dictionary.version).toBe(7);
    expect(laterStamp.changed).toBe(false);

    const changed = await run([...base, '--overlay', OVERLAY, '--previous', previousPath], () => {});
    expect(changed.changed).toBe(true);
    expect(changed.dictionary.version).toBe(8);
  });

  it('honours an explicit --version over the previous one', async () => {
    const dir = tmp();
    const first = await run(base, () => {});
    const previousPath = path.join(dir, 'previous.json');
    writeFileSync(previousPath, JSON.stringify({ ...first.dictionary, version: 3 }));
    const result = await run([...base, '--previous', previousPath, '--version', '42'], () => {});
    expect(result.dictionary.version).toBe(42);
  });

  it('passes options through to the generator', async () => {
    const result = await run([...base, '--title', 'Market tools', '--base-url', 'https://proxy.internal/api', '--default-category', 'misc'], () => {});
    expect(result.dictionary.title).toBe('Market tools');
    expect(result.dictionary.defaults?.baseUrl).toBe('https://proxy.internal/api');
  });

  it('demands the arguments it cannot invent', async () => {
    await expect(run(['--id', 'x'], () => {})).rejects.toThrow(/--openapi is required/);
    await expect(run(['--openapi', OPENAPI], () => {})).rejects.toThrow(/--id is required/);
  });

  it('fails loudly on a document that is not JSON', async () => {
    const dir = tmp();
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    await expect(run(['--openapi', bad, '--id', 'sample'], () => {})).rejects.toThrow(/not valid JSON/);
  });

  it('prints usage for --help without generating anything', async () => {
    const lines: string[] = [];
    await expect(run(['--help'], (line) => lines.push(line))).rejects.toThrow(CliError);
    expect(lines.join('')).toContain('tool-dictionary-gen');
  });
});

describe('main', () => {
  it('writes the document to --out and the notes to stderr', async () => {
    const dir = tmp();
    const out = path.join(dir, 'dictionary.json');
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    const code = await main([...base, '--out', out]);
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8')) as Dictionary;
    expect(written.id).toBe('sample');
    expect(errors.join('')).toContain('sample v1');
    expect(errors.join('')).toContain('note:');
  });

  it('--quiet prints only the document', async () => {
    const dir = tmp();
    const out = path.join(dir, 'dictionary.json');
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    expect(await main([...base, '--out', out, '--quiet'])).toBe(0);
    expect(errors.join('')).toBe('');
  });

  it('--strict turns overlay issues into a non-zero exit', async () => {
    const dir = tmp();
    const out = path.join(dir, 'dictionary.json');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main([...base, '--overlay', OVERLAY, '--out', out, '--strict'])).toBe(1);
    expect(await main([...base, '--overlay', OVERLAY, '--out', out])).toBe(0);
  });

  it('reports a bad invocation as exit 2, not a stack trace', async () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    expect(await main(['--id', 'sample'])).toBe(2);
    expect(errors.join('')).toContain('--openapi is required');
  });

  it('writes to stdout when there is no --out', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main([...base, '--quiet'])).toBe(0);
    const doc = JSON.parse(chunks.join('')) as Dictionary;
    expect(doc.entries.length).toBeGreaterThan(5);
  });
});
