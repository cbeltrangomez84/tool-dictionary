<p align="center">
  <img src="assets/mark.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Tool Dictionary</h1>

<p align="center"><strong>Thousands of tools. The agent sees three.</strong></p>

<p align="center">
  A portable format for describing a large tool surface, and a tiny service that searches it —<br>
  so an agent finds the two or three tools it needs without ever loading the rest into its context.
</p>

<p align="center">
  <a href="spec/tool-dictionary-v0.1.md"><img alt="Spec 0.1 draft" src="https://img.shields.io/badge/spec-0.1_draft-5b7cfa"></a>
  <a href="https://github.com/cbeltrangomez84/tool-dictionary/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cbeltrangomez84/tool-dictionary/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-22c1c3"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-333">
</p>

---

```
DICTIONARY city-weather v1 — 1 result for "is it raining in Lisbon"

1. current_conditions — Current conditions
   Temperature, sky and wind in a city right now.
   path: weather
   input: city (string, required) — City name, optionally with country.
   returns: An object with tempC, sky, windKph and observedAt.
   call: GET https://api.weather.example/v1/current?city={city}  (auth: x-api-key header)
   see also: forecast_daily (pairs_with) — what comes next, once you know what it is like now
```

One search, one round, something callable. That is the contract.

## Why

Tool definitions are loaded into the model's context on every turn. At ten
tools that is free; at five hundred it is tens of thousands of tokens per turn,
and tool-selection accuracy has already collapsed. The accepted fix is
*progressive tool discovery*: show the model one search tool and let it pull in
the definitions it needs.

The mechanism exists — several vendors ship it, MCP has a draft. What none of
them define is **the catalog itself**: a portable file that says *here is my
tool surface, here are the words a person would use to ask for each tool, and
here is which other tool you probably meant.*

Tool Dictionary is that file, the small HTTP API that serves it, and a
reference implementation of both.

## What is different about it

**Relations ride in the search result.** An agent asked *"how many people hold
this token?"* searches `holders`, finds `holders_count`, answers `4,812` — and
the user wanted the distribution. Ranking cannot fix that; the query was
faithfully slightly wrong. So the correction hangs off the *answer*: the result
carries `holders_percentage` as an `alternative` with the reason *"share of
supply per holder, not a count"*. Nine relation types; the server materializes
the inverses so an author writes one direction.

**A miss returns the catalogue, never an empty list.** No match, empty query,
filters that removed everything — all return the category tree with sample
queries known to work. An empty list teaches an agent nothing and burns a round
it cannot spare.

**Budgets are enforced, not estimated.** The server measures the serialized
bytes and degrades in a specified order, protecting the top result at full
detail until the last step. A single search always fits, and always returns
something callable.

**The service never executes and never holds a key.** A dictionary says
`"value": "{{WEATHER_API_KEY}}"` — where the credential goes, never what it is.
Your executor fills it in. That is what makes a dictionary safe to serve
publicly in front of a private API: it leaks the shape of an API, not access.

**Generated, then overlaid.** Build the dictionary from OpenAPI on every deploy;
keep the human knowledge — synonyms, relations, the words people actually use —
in an overlay that merges deterministically on top. Hand-written goes stale;
generated is dumb; this is both fixed at once.

## Quick start

```bash
git clone https://github.com/cbeltrangomez84/tool-dictionary && cd tool-dictionary
npm install && npm run build
TD_ADMIN_TOKEN=dev npm run dev -- config/local.example.json
```

```bash
curl localhost:8080/v1/dictionaries                                        # what is loaded, plus a usage prompt
curl localhost:8080/v1/dictionaries/crypto-data/tool                       # tool declarations + system prompt, ready to paste
curl 'localhost:8080/v1/dictionaries/crypto-data/search?q=who+holds+this+token&format=text'
curl 'localhost:8080/v1/dictionaries/crypto-data/entries?format=text'      # every tool, one line each
```

Wiring an agent is two of those calls: `GET /v1/dictionaries` to learn what
exists, then `GET …/tool` for `search_tools` and `list_tools` with their
endpoints filled in and the prompt paragraph to go with them.

## Guides

| | |
|---|---|
| [Write your first dictionary](docs/write-your-first-dictionary.md) | Three tools by hand, validated, searched. Ten minutes. |
| [Generate one from OpenAPI](docs/generate-from-openapi.md) | Point the generator at a document, add an overlay, keep it fresh in CI. |
| [Connect an agent](docs/connect-an-agent.md) | Two HTTP calls to wire a dictionary into any model that can call tools. |
| [Run the service](docs/run-the-service.md) | Config, tokens, refresh, Docker, what `/health` tells you. |

## The specification

| | |
|---|---|
| [`spec/tool-dictionary-v0.1.md`](spec/tool-dictionary-v0.1.md) | The normative text: document, relations, index, HTTP API, search semantics, budgets, text rendering, versioning, generation, security, conformance |
| [`spec/schema/dictionary.schema.json`](spec/schema/dictionary.schema.json) | JSON Schema (2020-12) for the document |
| [`spec/examples/city-weather.dictionary.json`](spec/examples/city-weather.dictionary.json) | The smallest useful dictionary — three tools |
| [`spec/examples/crypto-data.dictionary.json`](spec/examples/crypto-data.dictionary.json) | Hand-written; the format at its best |
| [`spec/examples/pool-scout/`](spec/examples/pool-scout/README.md) | An OpenAPI document, an overlay, and the dictionary generated from the two |
| [`conformance/`](conformance/README.md) | Byte-exact vectors for the text rendering |

Version 0.1 is a draft. Media type `application/vnd.tool-dictionary+json; v=0.1`.

## The reference implementation

Node 20 + TypeScript, Fastify, no database. A dictionary is a document; the
index is built in memory at load and rebuilt on refresh. Five thousand entries
is a few megabytes and a BM25 query over it is sub-millisecond, so there is
nothing to operate beyond the process.

* **Service** — BM25 + trigram fuzzy search with synonyms; index fallback;
  enforced budgets; ETags and `304`; multi-tenant with read and admin tokens;
  pull-based refresh with last-good fallback; rate limiting. The search backend
  is a three-method interface, so a vector or hybrid backend slots in without
  touching the wire format.
* **Generator** — `tool-dictionary-gen`: OpenAPI 3.x in, valid dictionary out.
  Stable names, `returns` read off response schemas when descriptions are
  placeholders, auth placement from `securitySchemes`, version bump only on real
  change, `--strict` for CI.
* **Overlay merge** — deterministic, idempotent, and loud about keys that no
  longer match anything.
* **`resolveCall`** — the executor's half: entry + input + your variables → a
  concrete request. Exported so every executor applies the same rules.

```bash
npm run check    # typecheck + 142 tests + schema validation + build
```

## Status

| | |
|---|---|
| Specification 0.1 | Draft — complete, open to change before 1.0 |
| JSON Schema | Done |
| Reference service | Done |
| Generator + overlays | Done |
| Conformance vectors | Text rendering |

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before proposing a change; the one
rule is that the spec, the schema and the implementation agree at every commit.
Spec section 18 lists what is deliberately left out.

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Carlos Beltran.
