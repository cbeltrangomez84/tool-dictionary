# Changelog

All notable changes to the specification and the reference implementation.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
specification version and the package version move together while 0.x.

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

[0.1.0]: https://github.com/cbeltrangomez84/tool-dictionary/releases/tag/v0.1.0
