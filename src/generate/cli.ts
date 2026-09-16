#!/usr/bin/env node
/**
 * `tool-dictionary-gen` — OpenAPI 3.x + overlay → a dictionary document.
 *
 * The output is the input of the service: it is validated before it is written,
 * so a generator run either produces a servable catalog or fails loudly. Notes
 * and overlay issues go to stderr; only the document goes to stdout, so the
 * command composes (`tool-dictionary-gen ... | curl --data-binary @-`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateFromOpenApi, GenerateError, type GenerateOptions } from './openapi';
import { applyOverlay, OverlayError, type OverlayIssue } from './overlay';
import { validateDictionary } from '../validate';
import { etagOf } from '../etag';
import type { Dictionary } from '../types';

const USAGE = `tool-dictionary-gen — generate a Tool Dictionary from an OpenAPI 3.x document

Usage:
  tool-dictionary-gen --openapi <file|url> --id <dictionary-id> [options]

Required:
  --openapi <file|url>   OpenAPI 3.x document (JSON).
  --id <id>              Dictionary id.

Options:
  --version <n>          Catalog version. Default: 1. With --previous, bumped only
                         when the content actually changed.
  --previous <file>      Previous dictionary; reuses its version when nothing changed
                         and sets version = previous + 1 when it did.
  --overlay <file>       Overlay 0.1 document with the human knowledge to merge in.
  --title <text>         Dictionary title. Default: OpenAPI info.title.
  --summary <text>       Dictionary summary. Default: first sentence of info.description.
  --base-url <url>       Override servers[0] as the call base URL.
  --source-url <url>     Recorded in sources[].url. Default: the --openapi value.
  --overlay-url <url>    Recorded in sources[].url for the overlay. Default: file://<--overlay>.
  --strip-prefix <seg>   Path segment to strip before naming (repeatable). Default: v<digits>.
  --default-category <c> Category for untagged operations. Default: general.
  --max-keywords <n>     Keyword seeds per entry. Default: 20.
  --skip-deprecated      Drop deprecated operations instead of demoting them.
  --generated-at <iso>   Timestamp to stamp (default: now). Use for reproducible output.
  --out <file>           Write here instead of stdout.
  --quiet                Only print errors.
  --strict               Exit non-zero on warnings and overlay issues too.
  -h, --help             This text.
`;

export class CliError extends Error {}

interface Args {
  openapi?: string;
  id?: string;
  version?: string;
  previous?: string;
  overlay?: string;
  title?: string;
  summary?: string;
  baseUrl?: string;
  sourceUrl?: string;
  overlayUrl?: string;
  stripPrefix: string[];
  defaultCategory?: string;
  maxKeywords?: string;
  skipDeprecated: boolean;
  generatedAt?: string;
  out?: string;
  quiet: boolean;
  strict: boolean;
  help: boolean;
}

const FLAGS: Record<string, keyof Args> = {
  '--openapi': 'openapi',
  '--id': 'id',
  '--version': 'version',
  '--previous': 'previous',
  '--overlay': 'overlay',
  '--title': 'title',
  '--summary': 'summary',
  '--base-url': 'baseUrl',
  '--source-url': 'sourceUrl',
  '--overlay-url': 'overlayUrl',
  '--default-category': 'defaultCategory',
  '--max-keywords': 'maxKeywords',
  '--generated-at': 'generatedAt',
  '--out': 'out',
};

export function parseArgs(argv: string[]): Args {
  const args: Args = { stripPrefix: [], skipDeprecated: false, quiet: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token === '--skip-deprecated') {
      args.skipDeprecated = true;
      continue;
    }
    if (token === '--quiet') {
      args.quiet = true;
      continue;
    }
    if (token === '--strict') {
      args.strict = true;
      continue;
    }
    // `--flag=value` and `--flag value` are both accepted.
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const read = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new CliError(`${name} needs a value`);
      i += 1;
      return next;
    };
    if (name === '--strip-prefix') {
      args.stripPrefix.push(read());
      continue;
    }
    const key = FLAGS[name];
    if (!key) throw new CliError(`unknown option ${name}`);
    (args as unknown as Record<string, string>)[key] = read();
  }
  return args;
}

async function readSource(location: string): Promise<{ text: string; url: string }> {
  if (/^https?:\/\//i.test(location)) {
    const response = await fetch(location, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new CliError(`GET ${location} → ${response.status}`);
    return { text: await response.text(), url: location };
  }
  const resolved = path.resolve(location);
  return { text: readFileSync(resolved, 'utf8'), url: `file://${resolved}` };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Version discipline (spec 7): consumers cache on `version`, so it must move
 * when the content moves and stay put when it does not. Compare everything
 * except the fields that change on every run.
 */
function resolveVersion(dictionary: Dictionary, previous: Dictionary | undefined, explicit: number | undefined): { version: number; changed: boolean } {
  if (!previous) return { version: explicit ?? 1, changed: true };
  const changed = contentEtag(dictionary) !== contentEtag(previous);
  if (explicit !== undefined) return { version: explicit, changed };
  return { version: changed ? previous.version + 1 : previous.version, changed };
}

function contentEtag(dictionary: Dictionary): string {
  const copy = JSON.parse(JSON.stringify(dictionary)) as Record<string, unknown>;
  delete copy.version;
  delete copy.generatedAt;
  delete copy.sources;
  return etagOf(copy);
}

export interface RunResult {
  dictionary: Dictionary;
  notes: string[];
  issues: OverlayIssue[];
  warnings: { at: string; message: string }[];
  changed: boolean;
}

export async function run(argv: string[], log: (line: string) => void): Promise<RunResult> {
  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    throw new CliError('');
  }
  if (!args.openapi) throw new CliError('--openapi is required');
  if (!args.id) throw new CliError('--id is required');

  const source = await readSource(args.openapi);
  const doc = parseJson(source.text, 'the OpenAPI document');

  const options: GenerateOptions = {
    id: args.id,
    version: args.version ? Number(args.version) : 1,
    sourceUrl: args.sourceUrl ?? source.url,
  };
  if (args.title !== undefined) options.title = args.title;
  if (args.summary !== undefined) options.summary = args.summary;
  if (args.generatedAt !== undefined) options.generatedAt = args.generatedAt;
  if (args.baseUrl !== undefined) options.baseUrl = args.baseUrl;
  if (args.stripPrefix.length) options.stripPrefixes = args.stripPrefix;
  if (args.defaultCategory !== undefined) options.defaultCategory = args.defaultCategory;
  if (args.maxKeywords !== undefined) options.maxKeywords = Number(args.maxKeywords);
  if (args.skipDeprecated) options.includeDeprecated = false;

  const generated = generateFromOpenApi(doc, options);
  let dictionary = generated.dictionary;
  let issues: OverlayIssue[] = [];

  if (args.overlay) {
    const overlayPath = path.resolve(args.overlay);
    const overlayDoc = parseJson(readFileSync(overlayPath, 'utf8'), 'the overlay') as Record<string, unknown>;
    // A checked-in dictionary must not depend on where the checkout lives, so
    // the recorded overlay URL can be pinned, exactly like --source-url.
    overlayDoc.$source = args.overlayUrl ?? `file://${overlayPath}`;
    const merged = applyOverlay(dictionary, overlayDoc);
    dictionary = merged.dictionary;
    issues = merged.issues;
  }

  const previous = args.previous ? (parseJson(readFileSync(path.resolve(args.previous), 'utf8'), 'the previous dictionary') as Dictionary) : undefined;
  const { version, changed } = resolveVersion(dictionary, previous, args.version ? Number(args.version) : undefined);
  dictionary.version = version;

  const validation = validateDictionary(dictionary);
  if (!validation.ok) {
    const lines = validation.errors.map((e) => `  ${e.at}: ${e.message}`).join('\n');
    throw new CliError(`the generated dictionary is invalid:\n${lines}`);
  }

  return { dictionary, notes: generated.notes, issues, warnings: validation.warnings, changed };
}

export async function main(argv: string[]): Promise<number> {
  const quiet = argv.includes('--quiet');
  const strict = argv.includes('--strict');
  let result: RunResult;
  try {
    result = await run(argv, (line) => process.stdout.write(line));
  } catch (error) {
    if (error instanceof CliError) {
      if (error.message) process.stderr.write(`tool-dictionary-gen: ${error.message}\n`);
      return error.message ? 2 : 0;
    }
    if (error instanceof GenerateError || error instanceof OverlayError) {
      process.stderr.write(`tool-dictionary-gen: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const body = `${JSON.stringify(result.dictionary, null, 2)}\n`;
  const outIndex = argv.findIndex((a) => a === '--out' || a.startsWith('--out='));
  const out = outIndex === -1 ? undefined : argv[outIndex]?.includes('=') ? argv[outIndex]?.split('=').slice(1).join('=') : argv[outIndex + 1];
  if (out) writeFileSync(path.resolve(out), body);
  else process.stdout.write(body);

  if (!quiet) {
    const where = out ? path.resolve(out) : 'stdout';
    process.stderr.write(`${result.dictionary.id} v${result.dictionary.version} — ${result.dictionary.entries.length} entries → ${where}${result.changed ? '' : ' (unchanged)'}\n`);
    for (const note of result.notes) process.stderr.write(`  note: ${note}\n`);
    for (const issue of result.issues) process.stderr.write(`  overlay: ${issue.at}: ${issue.message}\n`);
    for (const warning of result.warnings) process.stderr.write(`  warning: ${warning.at}: ${warning.message}\n`);
  }
  if (strict && (result.issues.length || result.warnings.length)) return 1;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`tool-dictionary-gen: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
