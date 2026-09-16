/**
 * Turns an entry plus the caller's input and variables into a concrete HTTP
 * request. This is the executor's half of spec 5.5: the dictionary says where
 * `{{VARIABLE}}` and `{param}` go, the executor holds the values, and this is
 * the one place the two meet. The server never calls it — a dictionary service
 * must not know a credential — but every executor needs the same rules, so
 * they live here rather than being re-derived by each one.
 */
import { effectiveCall } from './load';
import type { Dictionary, Entry, HttpCall } from './types';
import { AUTH_VALUE, VARIABLE_REF } from './validate';

export interface ResolveOptions {
  input?: Record<string, unknown>;
  /** Values for every `{{VARIABLE}}` the call references, including the secret behind `auth.value`. */
  variables?: Record<string, string>;
}

export interface ResolvedRequest {
  method: HttpCall['method'];
  url: string;
  headers: Record<string, string>;
  /** Absent for calls without a body template. */
  body?: unknown;
}

export class ResolveError extends Error {
  constructor(
    message: string,
    public readonly missing?: { kind: 'variable' | 'param'; name: string },
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** Both placeholder kinds in one pass, so a substituted value is never scanned again. */
const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}|(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g;

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function resolveCall(entry: Entry, dictionary: Dictionary, options: ResolveOptions = {}): ResolvedRequest {
  const call = effectiveCall(entry, dictionary);
  if (call.type !== 'http') throw new ResolveError(`entry "${entry.name}" is a ${call.type} call, not http`);
  const input = options.input ?? {};
  const variables = options.variables ?? {};

  const variable = (name: string): string => {
    const value = variables[name];
    if (value === undefined) throw new ResolveError(`variable {{${name}}} was not supplied`, { kind: 'variable', name });
    return value;
  };
  /** `undefined` means an optional input was absent and the whole value should be dropped. */
  const substitute = (text: string, opts: { encode: boolean; required: boolean }): string | undefined => {
    let dropped = false;
    const out = text.replace(TOKEN, (_, variableName: string | undefined, paramName: string | undefined) => {
      if (variableName !== undefined) return variable(variableName);
      const value = input[paramName!];
      if (value === undefined) {
        if (opts.required) throw new ResolveError(`input "${paramName}" was not supplied`, { kind: 'param', name: paramName! });
        dropped = true;
        return '';
      }
      return opts.encode ? encodeURIComponent(stringify(value)) : stringify(value);
    });
    return dropped ? undefined : out;
  };

  // Plain concatenation, exactly as the text rendering shows it (spec 11.4):
  // a baseUrl with a path prefix keeps that prefix.
  const base = call.baseUrl ? substitute(call.baseUrl, { encode: true, required: true })! : '';
  const path = substitute(call.urlTemplate, { encode: true, required: true })!;
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    throw new ResolveError(`entry "${entry.name}" resolves to an invalid URL: ${base}${path}`);
  }
  // An optional input that is absent drops its query parameter or header rather than sending an empty one.
  for (const [key, template] of Object.entries(call.query ?? {})) {
    const value = substitute(template, { encode: false, required: false });
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {};
  for (const [key, template] of Object.entries(call.headers ?? {})) {
    const value = substitute(template, { encode: false, required: false });
    if (value !== undefined) headers[key] = value;
  }

  const auth = call.auth;
  if (auth?.kind === 'caller' && auth.in && auth.name && auth.value) {
    const match = AUTH_VALUE.exec(auth.value);
    if (!match) throw new ResolveError(`auth.value of "${entry.name}" is not a {{VARIABLE}} reference`);
    const value = auth.value.replace(VARIABLE_REF, () => variable(match[1]!));
    if (auth.in === 'header') headers[auth.name] = value;
    else url.searchParams.set(auth.name, value);
  }

  const request: ResolvedRequest = { method: call.method, url: url.toString(), headers };
  if (call.bodyTemplate === null) request.body = input;
  else if (call.bodyTemplate !== undefined) request.body = fill(call.bodyTemplate, input, (text) => substitute(text, { encode: false, required: true })!);
  return request;
}

/** Substitutes into a body template. A leaf that is exactly `{param}` keeps the input value's type. */
function fill(template: unknown, input: Record<string, unknown>, substitute: (text: string) => string): unknown {
  if (typeof template === 'string') {
    const whole = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template);
    if (whole) {
      const value = input[whole[1]!];
      if (value === undefined) throw new ResolveError(`input "${whole[1]}" was not supplied`, { kind: 'param', name: whole[1]! });
      return value;
    }
    return substitute(template);
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, input, substitute));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) out[key] = fill(value, input, substitute);
    return out;
  }
  return template;
}
