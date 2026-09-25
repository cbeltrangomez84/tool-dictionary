# Changelog

All notable changes to the specification and the reference implementation.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
specification version and the package version move together while 0.x.

## [0.2.2] — 2026-09-24

### Specification
- Execute response (§9.7.2): a deployment may relay metering headers, the
  headers an upstream uses to report what a call cost. Optional and
  deployment-side; no document or request changes.

### Reference implementation
- `execution.meteringHeaders`: each named header is summed over the upstream
  calls a request makes and set on every response — the total on execute, `0`
  everywhere else (search, entries, health, errors, 429). Missing or
  non-numeric upstream values count as `0`; headers the service owns are
  refused at start. `/v1/health` lists the names.

## [0.2.1] — 2026-09-24

### Specification
- Briefs (§5.6): an entry may declare `briefOf`, naming the entry of the same
  dictionary whose question it answers in a compact response. The server
  materializes the other side's `brief`; both render at `summary` detail as
  `BRIEF` lines (§11.4), and the system prompt (§14.2) tells the agent to call
  the brief first. One level only, one brief per entry (§17.1 rule 9). The field
  is additive: every 0.2.0 document is still valid.

### Reference implementation
- Validation, load-time `brief` materialization, branch-merge renames and the
  overlay's `briefOf` patch key; hiding the full entry drops the brief's
  `briefOf` with an issue.
- `interpretedAs` reports a synonym only on a whole-word match, and multi-word
  synonym members expand (they are tokenized like the query).

## [0.2.0] — 2026-09-17

Service API amendment. The document format is unchanged: every 0.1 dictionary
is a valid 0.2 dictionary and still says `"toolDictionary": "0.1"`. Everything
below is opt-in for the deployment and invisible to a consumer that does not
use it; a server with execution off is exactly a 0.1 server.

### Specification
- `POST /v1/dictionaries/{id}/execute` (§9.7): the service may run one entry of
  its own catalogue on the caller's behalf. Validates `params` against the input
  schema before calling, renders the descriptor, forwards the caller's own
  credential from the request header (the header the entry names, or the
  generic `X-Td-Var-<NAME>`), never follows redirects, bounds the call by a
  deadline and an upstream read cap, and returns the result under the response
  byte budget. Upstream 4xx/5xx are results, not service errors. New error
  codes: `execution_disabled`, `not_executable`, `invalid_params`,
  `missing_credential`, `missing_variable`, `target_not_allowed`,
  `upstream_redirect`, `upstream_error`, `upstream_timeout`.
- §16.1 rewritten from "the service never executes" to "the service never holds
  credentials at rest, and calls only what an installed dictionary declares":
  the resolved origin must be one of the dictionary's declared origins, with
  `{{VARIABLE}}` hosts filled from deployment configuration and caller-placed
  hosts declaring nothing. §16.5 gains the execution caps; §17.2 the matching
  conformance items.
- `execute_tool` (§14.5): a third agent-facing tool, `{ name, params,
  dictionary? }`, declared only where execution is on. `search_tools` gains an
  optional `dictionary`. The system prompt explains the search → execute loop
  when the tool is present. The bundle carries `"execute": true|false`.
- Service-level routes `/v1/search`, `/v1/execute`, `/v1/entries`, `/v1/tool`
  (§9.8) resolve a `dictionary` argument, or pick the only visible dictionary;
  several without a name is `400 dictionary_required` listing the ids. The
  per-dictionary routes accept the argument and reject a mismatch.
- Request envelope (§9.8): every POST route accepts the bare arguments or
  `{ "tool", "input": { …args }, "chatId", "callId", … }`, the shape agent
  runtimes forward.
- Dictionary list (§9.6) items carry `execute` and, when true, an `execute`
  endpoint.

### Reference implementation
- `execution` config block (`enabled`, `maxTimeoutMs`, `defaultTimeoutMs`,
  `maxResponseBytes`, `variables`) and `TD_EXECUTE=true|false`; per-dictionary
  `"execute": false` opt-out. Off by default.
- `Executor` (exported, injectable `fetch`): Ajv validation with schema
  defaults applied, origin allow-list from `declaredOrigins`, `redirect:
  'manual'`, `AbortController` deadline, streamed read capped at
  `maxResponseBytes`, credential redacted from bodies and error messages,
  exact-budget shaping with `usedBytes` settled to the final byte count.
- `renderExecuteText` for `format: "text"` results.
- `/v1/health` reports the execution settings (variable names only).
- `DictionaryService.execute`, `resolveDictionary`, `executable`.
- 27 new tests (execution, envelope, agent declarations, config parsing).

## [0.1.1] — 2026-09-16

### Reference implementation
- `trustProxy` option (config key and `TD_TRUST_PROXY`), forwarded to Fastify.
  Behind a reverse proxy the per-IP rate limit keyed every anonymous caller on
  the proxy's address, so the limit was either meaningless or an outage.
- `prepare` script builds on install, so the package can be pinned as an npm
  git dependency (`npm install github:cbeltrangomez84/tool-dictionary#<ref>`).
  The Dockerfile installs with `--ignore-scripts` accordingly.
- `renderResultsText`, `renderIndexText` and `renderEntriesText` are exported
  from the package entrypoint.

## [0.1.0] — 2026-09-16

First public draft.

### Specification
- The dictionary document: entries, keywords, JSON Schema inputs, call
  descriptors for HTTP, MCP and local tools, `{{VARIABLE}}` references that
  carry a credential's *place* and never its value.
- Nine typed relations between tools, with inverses materialized by the server.
- A category index with sample queries, served as the fallback for every miss.
- Sub-dictionaries (branches) resolved at load time and marked degraded, never
  dropped, when they fail.
- HTTP API: search (`GET`/`POST`), index, entries list, dictionary list, and a
  served agent bundle (`/tool`) with tool declarations and a system prompt.
- Response budgets with a specified degradation order; `auto` detail.
- A normative plain-text rendering, frozen as byte-exact conformance vectors.
- ETags, `304`, and the pull-never-register freshness model.
- Generation from OpenAPI 3.x with a deterministic overlay merge.

### Reference implementation
- Fastify service: BM25 + trigram search with synonyms, multi-tenant, read and
  admin tokens, rate limiting, live refresh with last-good fallback.
- `tool-dictionary-gen`: OpenAPI → dictionary, overlay 0.1, stable naming,
  version bump only on real change, `--strict` for CI.
- Worked example: a fictional liquidity-pool API and the overlay that makes it
  searchable in a caller's words.

[0.2.0]: https://github.com/cbeltrangomez84/tool-dictionary/releases/tag/v0.2.0
[0.1.1]: https://github.com/cbeltrangomez84/tool-dictionary/releases/tag/v0.1.1
[0.1.0]: https://github.com/cbeltrangomez84/tool-dictionary/releases/tag/v0.1.0
