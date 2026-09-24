# Tool Dictionary Specification

**Version:** 0.2 (draft)
**Status:** Draft for implementation — supersedes 0.1
**Date:** 2026-09-17
**Media type:** `application/vnd.tool-dictionary+json; v=0.2`

A portable file format for describing a large set of callable tools, and an HTTP
API for searching it — and, where a deployment allows it, for running what was
found — so that an agent can find the two or three tools it needs among
thousands without ever seeing the rest, and use them without ever seeing a URL
or a credential.

### Changes from 0.1

0.2 amends the service API and the agent-facing surface. The document format
gains one optional entry field, `briefOf`; a 0.2 server serves documents with
`toolDictionary: "0.1"`, and every 0.1 document is a valid 0.2 document. Nothing that 0.1 required is
removed; every addition is opt-in for the deployment and invisible to a consumer
that does not use it.

* **Execution** ([§9.7](#97-execute)): a deployment MAY let the service run an
  entry of its own catalogue on the caller's behalf. The caller names a tool and
  gives inputs; the service renders the descriptor, forwards the caller's own
  credential, performs the call and returns the result under the same byte
  budget rules as a search. Off by default. [§16.1](#161-what-the-service-may-call)
  is rewritten accordingly.
* **`execute_tool`** ([§14.5](#145-execute_tool)): a third agent-facing tool,
  declared only when execution is on, so that the model's whole loop is
  *search → execute by name* and it never handles an endpoint.
* **Service-level routes and the `dictionary` argument**
  ([§9.8](#98-service-level-routes-and-the-request-envelope)): `search_tools`
  and `execute_tool` accept an optional `dictionary`; `/v1/search`,
  `/v1/execute`, `/v1/entries` and `/v1/tool` resolve it, or pick the only
  dictionary the caller can see.
* **Request envelope** ([§9.8](#98-service-level-routes-and-the-request-envelope)):
  POST bodies are accepted either as the arguments themselves or wrapped as
  `{ "tool", "input": { …args }, … }`, the shape agent runtimes forward.
* **Briefs** ([§5.6](#56-briefs)): an entry MAY declare `briefOf`, naming the
  entry whose question it answers in a compact response. The server sets the
  other side's `brief`, both render at `summary` detail, and the system prompt
  tells the agent to call the brief first.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, RECOMMENDED,
MAY and OPTIONAL are to be interpreted as described in RFC 2119.

---

## 0. Table of contents

1. [Why this exists](#1-why-this-exists)
2. [Relationship to existing work](#2-relationship-to-existing-work)
3. [Model and vocabulary](#3-model-and-vocabulary)
4. [The dictionary document](#4-the-dictionary-document)
5. [Entries](#5-entries)
6. [Relations](#6-relations)
7. [The index](#7-the-index)
8. [Sub-dictionaries (branches)](#8-sub-dictionaries-branches)
9. [The HTTP API](#9-the-http-api)
10. [Search semantics](#10-search-semantics)
11. [Response budgets and detail levels](#11-response-budgets-and-detail-levels)
12. [Empty and no-match queries](#12-empty-and-no-match-queries)
13. [Versioning, ETags and caching](#13-versioning-etags-and-caching)
14. [The agent-facing tool](#14-the-agent-facing-tool)
15. [Generation, overlays and provenance](#15-generation-overlays-and-provenance)
16. [Security model](#16-security-model)
17. [Conformance](#17-conformance)
18. [Deliberate omissions and open questions](#18-deliberate-omissions-and-open-questions)

---

## 1. Why this exists

An agent's tool list is loaded into the model's context on every turn. That is
fine for ten tools and impossible for five hundred: the definitions alone cost
tens of thousands of tokens per turn, and selection accuracy collapses well
before the context does.

The accepted answer is *progressive tool discovery*: show the model one tool — a
search tool — and let it pull in the handful of definitions it needs, on demand.
The mechanism is settled and several vendors implement it.

What is **not** settled is the artifact the mechanism searches. Every existing
implementation searches whatever definitions the caller happened to ship in that
request. There is no portable file that says *here is my tool catalog*, no place
to record the words a human would actually use to ask for a tool, and — the part
this specification cares about most — no way to say **"if you wanted this, you
probably also want that."**

That last point is the difference between a search index and a dictionary. When
someone looks up a word in a dictionary they get the definition, but also the
synonyms, the antonyms and the related forms, and that is usually where they find
the word they were actually reaching for. An agent asked *"how many people hold
this token?"* will search `holders`, find `holders_count`, answer `4,812`, and be
wrong — the user wanted the distribution. A dictionary entry for `holders_count`
that carries `holders_percentage` as an `alternative` fixes that in one round,
with no extra tool call and no extra model turn.

This specification defines that file, and the smallest API that serves it.

### Design constraints taken as given

These come from the first real consumer and are stated up front because they
shape everything:

* **No provider-side magic.** The search must be a real tool over plain HTTP,
  callable by a client that has no native tool-calling at all. It cannot depend
  on any vendor's deferred-loading feature.
* **One round.** Discovery competes with real work inside a small budget of tool
  rounds (three, in the first consumer). A design that needs *search → describe →
  call* has already spent the whole turn. A single search MUST be able to return
  something immediately callable.
* **Hard response caps.** 10 s deadline, 64 KB response, 16,000 characters of
  result actually shown to the model. The format is designed around that budget
  rather than discovering it later.
* **The dictionary never executes anything and never holds a credential.** It
  answers "which tool, and where does it live". The caller's own backend executes
  the call, adding its own keys. This boundary is what makes the service safe to
  deploy anywhere, including next to someone else's API.

---

## 2. Relationship to existing work

### Anthropic tool search tool (Nov 2025)

Anthropic ships a server-side search over the tools you send: each tool carries
`defer_loading: true`, one search tool stays loaded, and matches come back as
`tool_reference` blocks which the API expands into full definitions. Two variants
exist (`tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`), both
searching names, descriptions, argument names and argument descriptions. Up to
10,000 deferred tools per request; default 5 results, `limit` 1–10,000.

Two things matter here.

First, **you still send every definition on every request.** `defer_loading`
controls what enters the model's context, not what crosses the wire. So the
catalog still has to exist somewhere, be assembled, and be kept fresh — and that
is exactly the problem this specification addresses. Anthropic solves context
cost; it does not solve catalog management.

Second, Anthropic documents a **custom tool search implementation**: your own
tool returns a normal `tool_result` whose content is an array of
`{"type": "tool_reference", "tool_name": "..."}` blocks, and the API expands them
identically. That is the seam this specification plugs into. A Tool Dictionary
server that also emits `tool_reference` blocks is a drop-in custom search for the
Anthropic API, while remaining a plain HTTP service for everyone else. See
[§14.3](#143-anthropic-tool_reference-compatibility-mode).

**Where this spec deviates, and why:** Anthropic has no catalog file, no
categories, no keywords beyond whatever is in the description, no relations, and
an empty result set on a miss. This spec adds all five, and makes a miss return
the index instead of nothing ([§12](#12-empty-and-no-match-queries)).

### OpenAI Agents SDK

Has an equivalent deferred-loading / dynamic-toolset feature. Same shape, same
gap: it filters a toolset you already hold.

### MCP SEP #1888 — Progressive Disclosure for Typed Library Discovery

Draft, Standards Track, unratified. Proposes a per-library
`<library>.searchTools` tool with two modes (`operations`, `types`), structured
**filters** rather than free text (`resourceType` required, plus `action`,
`scope`, `riskLevel`, `exclude`, `limit` ≤ 50), and an `OperationDescriptor`
carrying `operationId`, `module`, `riskLevel`, `parameters`, `inputSchema`,
`returnTypeRef`, `typeRefs`. Its target is typed SDKs — Kubernetes, cloud SDKs —
where the hard part is the *type graph*, so it also exposes a `types` mode with
dot-notation traversal.

**Where this spec agrees:** discovery is orthogonal to `tools/list` and must not
register everything; risk classification belongs on the entry; a single tool with
one clear input beats several discovery tools.

**Where this spec deviates:**

| SEP #1888 | This spec | Why |
|---|---|---|
| Structured filters, `resourceType` **required** | Free-text query, filters optional | An agent handed a user sentence does not know the resource type yet. Requiring it means the agent must already know the taxonomy — which is the thing it is trying to discover. This spec accepts free text *and* accepts filters, and returns the taxonomy when the text matches nothing. |
| No result on a bad filter | Never empty: falls back to the index | See [§12](#12-empty-and-no-match-queries). |
| No relations between operations | First-class typed `relations` | The single most common discovery failure is finding a *plausible* tool rather than the *right* one. |
| Type graph traversal (`mode: "types"`) | Out of scope | This spec targets flat-ish HTTP endpoints, not typed SDK surfaces. An entry carries JSON Schema inline; there is no separate type registry. A future profile could add one. |
| MCP-only, needs protocol ratification | Transport-neutral file + plain HTTP | Works today, with any client, including ones with no tool-calling at all. |

SEP #1888 and this specification are complementary rather than competing: an MCP
server could implement #1888 *on top of* a Tool Dictionary.

### Pattern write-ups

Published progressive-discovery patterns describe either hierarchical browsing
(`list_tools("/hubspot/deals/*")` → `describe_tools` → `execute_tool`) or
embedding search (`find_tools`). Reported reductions are large — one write-up
measures ~405k tokens of static definitions for 400 tools against ~5–6k with
dynamic loading.

The browsing variant costs multiple round trips, which the first consumer here
cannot afford. This spec keeps the hierarchy (it is how an agent learns what
exists) but makes a **single** search call able to return callable definitions,
with the hierarchy served as the *fallback* rather than as the required first
step. Search backend choice (BM25 vs embeddings) is explicitly an implementation
detail behind an interface ([§10.5](#105-pluggable-backends)).

---

## 3. Model and vocabulary

**Dictionary** — one JSON document describing one coherent set of tools. The unit
of versioning, caching and tenancy.

**Entry** — one callable tool. A leaf.

**Index** — the tree of categories over the entries. Every entry sits at exactly
one `path`; the index is the set of paths, annotated.

**Node** — one position in the index tree. A node is either a plain category, or
a **branch** that delegates to a sub-dictionary ([§8](#8-sub-dictionaries-branches)).

**Relation** — a typed, directed link from one entry to another
([§6](#6-relations)).

**Detail level** — how much of an entry a response carries: `ref`, `summary` or
`full` ([§11](#11-response-budgets-and-detail-levels)).

**Server** — an implementation of [§9](#9-the-http-api).

**Consumer** — the agent runtime that calls the search tool.

**Executor** — whatever actually performs the call an entry describes. Always the
consumer's own backend, never the server.

---

## 4. The dictionary document

A dictionary is a single JSON object.

```json
{
  "toolDictionary": "0.1",
  "id": "crypto-data",
  "title": "Crypto market data",
  "summary": "Token, wallet, pool and trade data aggregated across 89 vendors.",
  "version": 47,
  "generatedAt": "2026-09-15T18:20:11Z",
  "locale": "en",
  "defaults": {
    "baseUrl": "https://data.example.com",
    "auth": { "kind": "caller", "in": "header", "name": "x-api-key", "value": "{{CRYPTO_DATA_API_KEY}}" },
    "variables": {
      "CRYPTO_DATA_API_KEY": { "secret": true, "description": "Issued per tenant. Held by the executor, never by this file." }
    },
    "timeoutHintMs": 3000
  },
  "synonyms": {
    "holder": ["hodler", "owner", "wallet holding"],
    "pnl": ["profit and loss", "p&l", "realized gain"]
  },
  "index": { "nodes": [ /* §7 */ ] },
  "entries": [ /* §5 */ ],
  "sources": [ /* §15.3 */ ],
  "extensions": {}
}
```

### 4.1 Fields

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `toolDictionary` | string | **yes** | Spec version this document conforms to. `"0.1"` here. Consumers MUST reject a major version they do not understand. |
| `id` | string | **yes** | Stable identifier, `^[a-z0-9][a-z0-9-]{0,63}$`. Unique within a server. Also the tenancy key. |
| `title` | string | **yes** | Human-readable name. |
| `summary` | string | **yes** | One line, ≤ 240 chars. Shown to the agent so it knows *what this dictionary is for at all*. |
| `version` | integer | **yes** | Monotonically increasing content version. MUST increase whenever any entry, index node or default changes. |
| `generatedAt` | RFC 3339 | **yes** | When this document was produced. |
| `locale` | BCP 47 | no | Language of prose fields. Default `"en"`. |
| `defaults` | object | no | Values inherited by every entry's `call` ([§5.4](#54-the-call-descriptor)): `baseUrl`, `auth`, `headers`, `timeoutHintMs`, and the `variables` the document references ([§5.5](#55-variables)). An entry overrides `baseUrl`, `auth` and `timeoutHintMs` wholesale; `headers` merge, entry keys winning. |
| `synonyms` | object | no | Canonical term → list of equivalents. Applied at query time ([§10.2](#102-normalization-and-synonyms)). |
| `index` | object | **yes** | The category tree ([§7](#7-the-index)). |
| `entries` | array | **yes** | The entries ([§5](#5-entries)). MAY be empty only if every index node is a branch. |
| `sources` | array | no | Provenance ([§15.3](#153-provenance)). |
| `extensions` | object | no | Implementation-specific data. Consumers MUST ignore keys they do not know. |

### 4.2 Extensibility rule

Consumers MUST ignore unknown object members anywhere in the document rather than
failing. Producers SHOULD confine non-standard data to `extensions` objects, which
exist at document, entry and node level.

### 4.3 Size

A dictionary document has no size limit — it is fetched by machines, not models.
A production dictionary of 600 entries is on the order of 1–3 MB. Servers SHOULD
serve it compressed.

---

## 5. Entries

```json
{
  "name": "holders_count",
  "title": "Token holder count",
  "summary": "Number of distinct wallets currently holding a token.",
  "description": "Returns the count of unique addresses with a non-zero balance of the given token at the latest indexed block. Counts addresses, not people; contract and burn addresses are included unless excluded explicitly.",
  "path": "tokens/holders",
  "keywords": ["holders", "holder count", "how many holders", "number of owners", "unique wallets"],
  "input": {
    "type": "object",
    "properties": {
      "address": { "type": "string", "description": "Token contract address or mint." },
      "chain": { "type": "string", "enum": ["solana", "ethereum", "base", "bsc"], "default": "solana" }
    },
    "required": ["address"]
  },
  "returns": "An integer count plus the block height it was measured at.",
  "call": {
    "type": "http",
    "method": "GET",
    "urlTemplate": "/v1/tokens/{address}/holders/count",
    "query": { "chain": "{chain}" }
  },
  "relations": [
    { "type": "alternative", "target": "holders_percentage", "reason": "share of supply per holder, not a count" },
    { "type": "pairs_with", "target": "holders_top", "reason": "who the largest holders are" },
    { "type": "prerequisite", "target": "token_resolve_symbol", "reason": "if you only have a ticker, not an address" }
  ],
  "risk": "read",
  "stability": "stable",
  "cost": { "tier": "standard" },
  "examples": [
    { "input": { "address": "So11111111111111111111111111111111111111112" }, "note": "wSOL on Solana" }
  ],
  "extensions": {}
}
```

### 5.1 Fields

| Field | Type | Req. | Notes |
|---|---|---|---|
| `name` | string | **yes** | `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. Unique within the dictionary. This is what the agent writes back, so it MUST be stable across versions — see [§13.4](#134-renaming-and-removal). |
| `title` | string | **yes** | ≤ 80 chars, human phrasing. |
| `summary` | string | **yes** | **≤ 200 chars, one sentence, plain language, no jargon.** This is the single most important field: it is what the agent reads at `summary` detail, and the budget is spent on it. It MUST describe what the tool *answers*, not how it is implemented. |
| `description` | string | no | ≤ 2000 chars. Full prose, including caveats and units. Carried only at `full` detail. |
| `path` | string | **yes** | Slash-separated index path, e.g. `tokens/holders`. MUST correspond to a node in the index. |
| `keywords` | string[] | no | The words a human would use. ≤ 32 items, each ≤ 64 chars. Multi-word phrases allowed and encouraged. |
| `input` | JSON Schema | **yes** | Draft 2020-12 subset, `type: "object"` at the root. MAY be `{"type":"object","properties":{}}` for a no-argument tool. ≤ 8 KB serialized. |
| `returns` | string | no | One line describing the shape of the answer, in prose. Not a schema: the agent needs to know whether to ask, not to parse. |
| `outputSchema` | JSON Schema | no | For consumers that do want to parse. Never carried below `full`. |
| `call` | object | **yes** | Where it lives ([§5.4](#54-the-call-descriptor)). |
| `relations` | array | no | ([§6](#6-relations)). ≤ 16 items. |
| `risk` | enum | no | `read` \| `write` \| `destructive` \| `admin`. Default `read`. Consumers MAY filter on it; policy layers SHOULD. Borrowed from SEP #1888. |
| `stability` | enum | no | `stable` \| `beta` \| `deprecated`. Default `stable`. |
| `deprecation` | object | no | `{ "since": "...", "replacedBy": "entry_name", "note": "..." }`. REQUIRED when `stability` is `deprecated`, and MUST carry `replacedBy` or `note` (see [§17.1](#171-a-conforming-dictionary) rule 7). |
| `cost` | object | no | `{ "tier": "free"\|"standard"\|"expensive", "note": "..." }`. Lets a consumer prefer a cheap equivalent. |
| `latencyHintMs` | integer | no | Typical, not guaranteed. |
| `examples` | array | no | ≤ 4 items, `{ "input": {...}, "note": "..." }`. Carried at `full` only. |
| `aliases` | string[] | no | Former names. Searchable; resolvable by `/entries/{name}` ([§13.4](#134-renaming-and-removal)). |
| `briefOf` | string | no | Name of the entry of this dictionary whose question this one answers in a compact response ([§5.6](#56-briefs)). Its counterpart `brief` is set by the server and never authored. |
| `extensions` | object | no | |

### 5.2 Writing a good `summary`

Non-normative but load-bearing. A `summary` is read by a model under budget
pressure, next to four others. Rules that work:

* Say what question it answers. `"Number of distinct wallets currently holding a
  token."` beats `"Holder count endpoint."`
* Name the unit. `"...as a percentage of circulating supply."`
* Say what it is **not**, when a sibling is easy to confuse with it. `"Count, not
  distribution — for the split see holders_percentage."` The relation says the
  same thing structurally, but a model reading prose catches it earlier.
* Never repeat the title. The renderer prints both.

### 5.3 Keywords are the point

An entry named `get_token_holder_statistics_v2` is invisible to anyone who asks
"how many people own this coin". Keywords exist to close that gap and SHOULD
include:

* the plain-English noun (`holders`, `owners`),
* the question form (`how many holders`),
* the jargon and the abbreviation (`hodlers`, `pnl`),
* the vendor's own term if it differs (`unique_wallets`).

Keywords MUST NOT be stuffed with terms the entry does not answer; a keyword that
matches everything makes the dictionary worse, and [§17](#17-conformance)
validation flags any keyword appearing on more than 25 % of entries.

### 5.4 The call descriptor

The dictionary says *where the tool lives* and *where the credential goes*. It
never carries the credential itself ([§5.5](#55-variables)).

```json
"call": {
  "type": "http",
  "method": "GET",
  "baseUrl": "https://data.example.com",
  "urlTemplate": "/v1/tokens/{address}/holders/count",
  "query": { "chain": "{chain}" },
  "headers": { "accept": "application/json" },
  "bodyTemplate": null,
  "auth": { "kind": "caller", "in": "header", "name": "x-api-key", "value": "{{CRYPTO_DATA_API_KEY}}" },
  "timeoutHintMs": 3000
}
```

| Field | Notes |
|---|---|
| `type` | `http` \| `mcp` \| `local`. Determines which other fields apply. |
| `method` | HTTP verb, for `type: "http"`. |
| `baseUrl` | Absolute origin, no query or fragment. Omitted ⇒ inherits `defaults.baseUrl`. MAY contain `{{VARIABLE}}` references. |
| `urlTemplate` | Path with `{param}` placeholders naming properties of `input`. Placeholders MUST resolve to declared input properties. MAY contain `{{VARIABLE}}` references. |
| `query` | Map of query parameter → literal, `{param}` placeholder or `{{VARIABLE}}` reference. |
| `headers` | Non-secret headers only. A server MUST reject a dictionary whose `headers` contains `authorization`, `cookie`, or any value matching a credential pattern ([§16.2](#162-no-credentials-ever)). The credential header goes in `auth`, not here. |
| `bodyTemplate` | For verbs with a body: a JSON value whose string leaves MAY be `{param}` placeholders. `null` ⇒ send `input` verbatim as the body. |
| `auth.kind` | `none` \| `caller`. `caller` means *the executor supplies it*. `none` on an entry opts out of `defaults.auth` — the executor sends nothing. |
| `auth.hint` | Free text for the human wiring the executor. MUST NOT contain a credential. |
| `auth.in`, `auth.name`, `auth.value` | The placement, for `kind: "caller"` and `type: "http"` only: `in` is `header` or `query`, `name` the header or parameter name, `value` a `{{VARIABLE}}` reference optionally behind a scheme word (`"Bearer {{X}}"`, `"Basic {{X}}"`). The three are all-or-none. The variable MUST be declared `secret: true`. This is the *only* field that may reference a secret. |
| `timeoutHintMs` | Advisory. |

For `type: "mcp"`: `{ "type": "mcp", "server": "<server id or url>", "tool": "<tool name>" }`.
For `type: "local"`: `{ "type": "local", "handler": "<opaque consumer-side id>" }`.

The three exist so that a dictionary can describe a mixed fleet — some endpoints,
some MCP tools, some in-process functions — without forcing everything through
HTTP. Servers MUST NOT attempt to call any of them.

---

### 5.5 Variables

Two placeholder syntaxes, on purpose distinct:

* `{param}` — single braces — names a property of the entry's `input`. The
  *agent* supplies it, per call.
* `{{VARIABLE}}` — double braces, `^[A-Z][A-Z0-9_]{0,63}$` — names a value the
  *executor* holds: an API key, a token, a region, a tenant id. The agent never
  sees it and the dictionary never carries it.

Every `{{VARIABLE}}` used anywhere in the document MUST be declared in
`defaults.variables`:

```json
"variables": {
  "CRYPTO_DATA_API_KEY": { "secret": true, "description": "Issued per tenant in the vendor dashboard." },
  "REGION": { "description": "Deployment region, e.g. eu or us." }
}
```

| Field | Notes |
|---|---|
| `secret` | `true` ⇒ the variable MAY be referenced only from `auth.value`. Referencing it from a URL, `query`, `headers` or `bodyTemplate` is a validation error, whatever the spelling: a key in a URL ends up in logs. Default `false`. |
| `description` | For the human wiring the executor. ≤ 200 chars. MUST NOT contain a value. |

The rules:

1. A server MUST reject a document that references an undeclared variable, or
   that references a secret one from anywhere but `auth.value`.
2. A server MUST NOT resolve variables. It serves the document with the
   placeholders in it, verbatim, in every format ([§11.4](#114-text-rendering)).
   It has no values to resolve them with, and that is the point
   ([§16.1](#161-the-service-never-executes)).
3. The *executor* resolves them from its own environment when it builds the
   request, in one pass together with `{param}`: a value substituted for one
   placeholder is never scanned for another. A missing variable is a hard error
   naming the variable, not an empty string sent upstream.
4. An entry MAY override `defaults.auth` (wholesale, including with
   `{ "kind": "none" }`) and `defaults.baseUrl`; `defaults.headers` merge with
   the entry's, the entry winning on a key. The declaration set is
   document-level: an entry cannot declare its own variables.
5. A declared variable that nothing references is a warning ([§17.3](#173-quality-warnings-non-fatal)).

The reference implementation ships the executor half as `resolveCall(entry,
dictionary, { input, variables })` → `{ method, url, headers, body }`, so that a
consumer does not re-derive the substitution and encoding rules.

### 5.6 Briefs

Some answers are too large for a model's context: a chart's full grid, a long
history, a whole order book. A producer that also offers a compact answer to
the same question — the strongest levels, the latest points, the top of the
book — publishes it as a separate entry and marks it with `briefOf`, naming
the full entry. The agent then has one rule: when a tool has a brief, call the
brief, and reach for the full tool only when it needs all of the data.

1. `briefOf` names an entry of the same dictionary, never the entry itself and
   never another dictionary's entry.
2. One level only: the named entry MUST NOT itself carry `briefOf`, and an
   entry has at most one brief. Two briefs of one tool would leave the agent to
   guess; a brief of a brief would point at a tool the agent never reaches.
3. A **server MUST set `brief`** on the named entry at load time, to the name
   of the entry that declared `briefOf`, replacing any `brief` the document
   carries. A producer never writes `brief`: one direction is authored, so the
   two sides cannot disagree.
4. Both fields render from `summary` detail up ([§11.4](#114-text-rendering)):
   which of the two tools to call is exactly the decision that level exists for.
5. When a branch merge renames the named entry ([§8.1](#81-resolution)), the
   `briefOf` that names it is renamed with it. When an overlay hides the named
   entry ([§15.2](#152-overlays)), the brief stays and loses its `briefOf`.

## 6. Relations

A relation is a typed, directed edge.

```json
{ "type": "alternative", "target": "holders_percentage", "reason": "share of supply per holder, not a count" }
```

| Field | Req. | Notes |
|---|---|---|
| `type` | **yes** | One of the types below. |
| `target` | **yes** | `name` of another entry **in this dictionary**, or `"<dictionaryId>#<name>"` for a cross-dictionary reference. |
| `reason` | **yes** | ≤ 120 chars. Why the agent might want it *instead of, or next to,* this one. Rendered verbatim in search results; it is what lets a model change its mind in one round. |
| `weight` | no | 0–1, default 1. Ranking hint. `weight` never appears in a response: a result carries its relations **sorted by weight, strongest first**, and at most **5** of them, so the order is what the consumer reads the weight from. |

### 6.1 Relation types

| Type | Meaning | Inverse |
|---|---|---|
| `alternative` | Answers the same question a different way. *The one that matters.* `holders_count` ↔ `holders_percentage`. | `alternative` (symmetric) |
| `narrower` | More specific case of this entry. `trades` → `trades_by_wallet`. | `broader` |
| `broader` | More general case. | `narrower` |
| `prerequisite` | You probably need this first. `holders_count` → `token_resolve_symbol`. | `enables` |
| `enables` | Inverse of `prerequisite`. | `prerequisite` |
| `pairs_with` | Commonly used together in one answer. | `pairs_with` (symmetric) |
| `successor` | Replaces this entry. Expected on a `deprecated` entry that has a replacement. | `predecessor` |
| `predecessor` | Inverse of `successor`. | `successor` |
| `same_data_other_source` | Same datum from a different vendor, differing in cost, latency or coverage. | symmetric |

### 6.2 Inverse materialization

A producer MAY declare only one direction. A **server MUST materialize the
inverse** of every declared relation at load time, unless the inverse is already
declared explicitly (in which case the explicit one wins and its `reason` is
kept). This is what makes relations survive hand-authoring: nobody remembers to
write both sides, and a one-sided graph makes discovery asymmetric for no reason.

An entry SHOULD carry at most one relation per `target`. Two relations to the
same tool render as that tool twice, and only one of the two reasons can be the
one the author meant; a validator SHOULD warn. When a hand-written overlay
([§15.2](#152-overlays)) adds a relation to a target the generator already
seeded, the added one **replaces** it.

Materialized inverses without an explicit `reason` inherit the forward `reason`,
prefixed per type (e.g. a `prerequisite` reason becomes the `enables` reason
unchanged — the sentence reads correctly in both directions in practice, and a
producer that disagrees declares the inverse explicitly).

### 6.3 Why relations, and not just better search

Search ranks by similarity to the *query*. The failure this addresses is a query
that is *itself* slightly wrong — the user asked one thing, meant another, and
the top hit matches what they asked. No amount of ranking fixes that, because
the ranking is faithful to a flawed input. Relations attach the correction to the
*answer* instead of the query: whatever you searched, if you land on
`holders_count` you are told `holders_percentage` exists and why you might want
it. That is a dictionary, and it is the piece none of the prior art has.

### 6.4 Validation

* `target` MUST resolve to a known entry (or a declared sub-dictionary reference).
  A dangling target is a validation error, not a warning.
* Relations MUST NOT be self-referential.
* Cycles are legal (`alternative` is symmetric by definition).
* A server SHOULD warn when an entry has zero relations and a sibling in the same
  index node exists — near-certain missing `alternative`.

---

## 7. The index

The index is the tree of categories. It exists so that an agent with a bad query,
or no query, can learn what is searchable at all.

```json
"index": {
  "nodes": [
    {
      "path": "tokens",
      "title": "Tokens",
      "summary": "Everything about one token: price, supply, holders, trades.",
      "entryCount": 214,
      "sampleQueries": ["token price", "who holds this token", "trade history"],
      "children": [
        {
          "path": "tokens/holders",
          "title": "Holders",
          "summary": "Who owns a token and in what proportion.",
          "entryCount": 31,
          "examples": ["holders_count", "holders_percentage", "holders_top"],
          "children": []
        }
      ]
    }
  ]
}
```

| Field | Req. | Notes |
|---|---|---|
| `path` | **yes** | Full slash-separated path, unique. Segment charset `^[a-z0-9][a-z0-9-]{0,39}$`. Max depth 5. |
| `title` | **yes** | ≤ 60 chars. |
| `summary` | **yes** | ≤ 160 chars. What lives here, in the user's words. |
| `entryCount` | no | Number of entries at or below this node. A server MUST recompute it rather than trust the file, and MUST populate it in every index response — so a producer may omit it. |
| `sampleQueries` | no | ≤ 5 queries that are known to return good results here. Directly usable by the agent as its next query — this is the cheapest possible recovery from a miss. |
| `examples` | no | ≤ 5 entry names, as a taste of what is inside. |
| `children` | no | Nested nodes. |
| `branch` | no | Sub-dictionary delegation ([§8](#8-sub-dictionaries-branches)). |
| `extensions` | no | |

Every entry's `path` MUST match some node's `path` exactly. Entries attach to
leaf-or-not nodes alike; a node may have both children and entries.

---

## 8. Sub-dictionaries (branches)

A node MAY delegate its subtree to another dictionary:

```json
{
  "path": "wallets",
  "title": "Wallets",
  "summary": "Wallet balances, history and PNL.",
  "entryCount": 96,
  "branch": {
    "dictionaryId": "wallet-analytics",
    "url": "https://dict.example.com/v1/dictionaries/wallet-analytics/catalog",
    "version": 12,
    "etag": "sha256:9f2c…"
  }
}
```

This is what lets a dictionary be, at any node, *another dictionary*. It exists
for two reasons:

1. **Ownership.** Different teams own different surfaces and ship on different
   cadences. A branch is a seam that does not require a coordinated release.
2. **Scale.** A 5,000-entry surface can be split without any consumer noticing.

### 8.1 Resolution

A server that loads a dictionary with branches MUST fetch each branch, validate
it, and merge it into one searchable space, re-rooting the child's paths under
the branch node's path. Search then spans the whole tree by default — the agent
does **not** navigate branches manually. Navigation is a fallback
([§12](#12-empty-and-no-match-queries)), not a required step, because required
navigation costs a round the consumer cannot spend.

* Depth limit: 3 levels of branching. Deeper MUST be rejected.
* A cycle (dictionary A branching to B branching back to A) MUST be detected and
  rejected at load.
* Name collisions across branches are resolved by prefixing the child's entry
  names with `<dictionaryId>.` **only on collision**, and recording the original
  in `aliases`. Uncollided names are left alone: churn in tool names is a real
  cost to the consumer.
* A branch that fails to fetch MUST NOT fail the parent. The server serves the
  parent with that subtree marked `"degraded": true` in the index node, and says
  so in the `notice` of any response whose results would have come from it.

---

## 9. The HTTP API

All paths are relative to a server base. All responses are `application/json`
unless `format=text` is requested ([§11.4](#114-text-rendering)).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/dictionaries/{id}/search` | **The tool the agent calls.** |
| `GET` | `/v1/dictionaries/{id}/search?q=…` | Same, for humans and caches. |
| `GET` | `/v1/dictionaries/{id}/index` | The category tree. |
| `GET` | `/v1/dictionaries/{id}/entries` | Every entry as one line ([§9.5](#95-entries-list)). |
| `GET` | `/v1/dictionaries/{id}/entries/{name}` | One entry at `full` detail. |
| `POST` | `/v1/dictionaries/{id}/entries:batchGet` | Several entries at once. |
| `POST` | `/v1/dictionaries/{id}/execute` | **Run one entry for the caller** ([§9.7](#97-execute)). Only where the deployment enables it. |
| `GET` | `/v1/dictionaries/{id}/tool` | The agent bundle: tool declarations + prompt ([§14.4](#144-served-not-copied)). |
| `GET` | `/v1/dictionaries/{id}/catalog` | The whole dictionary document. |
| `GET` | `/v1/dictionaries/{id}/version` | Cheap freshness probe. |
| `GET` | `/v1/dictionaries` | What is available and how to use it ([§9.6](#96-dictionary-list)). |
| `POST`/`GET` | `/v1/search`, `/v1/execute`, `/v1/entries`, `/v1/tool` | The same operations with the dictionary named in the request, or implied when only one is visible ([§9.8](#98-service-level-routes-and-the-request-envelope)). |
| `PUT` | `/v1/dictionaries/{id}` | Install/replace a dictionary (admin). |
| `POST` | `/v1/dictionaries/{id}/refresh` | Re-pull from `sources` (admin). |
| `GET` | `/v1/health` | Liveness + per-dictionary load status. |

`POST` is the primary form because the first consumer POSTs a JSON body to a tool
endpoint. `GET` exists so the same search is cacheable and pasteable.

### 9.1 Search request

```json
{
  "query": "how many people hold this token",
  "limit": 8,
  "detail": "auto",
  "path": "tokens",
  "risk": ["read"],
  "maxBytes": 12000,
  "format": "json",
  "cursor": null,
  "includeRelated": true
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string | `""` | Free text. ≤ 500 chars. Empty ⇒ index ([§12](#12-empty-and-no-match-queries)). |
| `limit` | integer | 8 | 1–50. A cap, not a target; the budget may cut it lower. |
| `detail` | enum | `"auto"` | `ref` \| `summary` \| `full` \| `auto` ([§11](#11-response-budgets-and-detail-levels)). |
| `path` | string | — | Restrict to a subtree. |
| `risk` | string[] | — | Allowed risk levels. Absent ⇒ all. |
| `maxBytes` | integer | server config | Hard cap on the serialized response. 1024–65536. |
| `format` | enum | `"json"` | `json` \| `text` \| `anthropic_tool_reference`. |
| `cursor` | string | — | Opaque; from a previous `nextCursor`. |
| `includeRelated` | boolean | `true` | Setting `false` is for benchmarks. |

Unknown request fields MUST be ignored, not rejected: the agent is a language
model and will occasionally invent one, and a 400 wastes a round.

Invalid *values* (e.g. `limit: 500`) MUST be clamped to the legal range, with a
`notice`, rather than rejected. Same reason.

### 9.2 Search response

```json
{
  "kind": "results",
  "dictionary": { "id": "crypto-data", "version": 47, "etag": "sha256:1c4f…" },
  "query": { "text": "how many people hold this token", "interpretedAs": ["holders", "count"] },
  "results": [
    {
      "name": "holders_count",
      "title": "Token holder count",
      "summary": "Number of distinct wallets currently holding a token.",
      "path": "tokens/holders",
      "detail": "full",
      "score": 14.2,
      "matchedOn": ["keywords", "summary"],
      "input": { "…": "…" },
      "call": { "…": "…" },
      "relations": [
        { "type": "alternative", "target": "holders_percentage", "reason": "share of supply per holder, not a count" }
      ]
    }
  ],
  "related": [
    {
      "name": "holders_percentage",
      "title": "Holder distribution",
      "summary": "What share of supply each holder controls, top-N or bucketed.",
      "path": "tokens/holders",
      "detail": "summary",
      "via": { "from": "holders_count", "type": "alternative", "reason": "share of supply per holder, not a count" }
    }
  ],
  "budget": { "maxBytes": 12000, "usedBytes": 3184, "truncated": false },
  "notice": null,
  "nextCursor": null
}
```

`kind` is `"results"` or `"index"`. A consumer MUST handle both from the same
call.

### 9.3 Index response

```json
{
  "kind": "index",
  "dictionary": { "id": "crypto-data", "version": 47, "etag": "sha256:1c4f…" },
  "query": { "text": "hodl statistics" },
  "reason": "no_match",
  "notice": "Nothing matched \"hodl statistics\". Here is what this dictionary covers — search again with one of the sample queries.",
  "suggestions": [
    { "name": "holders_count", "title": "Token holder count", "why": "did you mean \"holders\"?" }
  ],
  "index": { "nodes": [ /* depth-limited §7 nodes */ ] },
  "budget": { "maxBytes": 12000, "usedBytes": 2740, "truncated": false }
}
```

`reason` is `empty_query`, `no_match`, `below_threshold`, or `explicit`.

### 9.4 Errors

Only genuine faults produce non-2xx:

| Status | When |
|---|---|
| 404 | Unknown dictionary id, or unknown entry on `/entries/{name}`. |
| 401 / 403 | Auth on a protected dictionary. |
| 409 | `PUT` with a `version` not greater than the installed one. |
| 422 | `PUT` of a document that fails validation. Body lists every error. |
| 429 | Rate limited. `Retry-After` REQUIRED. |
| 503 | Dictionary known but not yet loaded. `Retry-After` REQUIRED. |
| 400 | `dictionary_required` — a service-level route with several visible dictionaries and none named; `details[0].dictionaries` lists them. `dictionary_mismatch` — a `dictionary` argument that disagrees with the path. |
| 400 / 401 / 403 / 404 / 422 / 500 / 502 / 504 | Execution faults, each with its own `code` ([§9.7.3](#973-execution-errors)). |

A search MUST NOT return 4xx for anything the agent could have written. Bad
query, weird filter, nonsense field — all of those return 200 with an index and a
`notice`. Execution is the one deliberate exception: inputs that do not match a
tool's schema are a 4xx that names the field, because a silently corrected call
to a real API is worse than a retry ([§9.7.3](#973-execution-errors)).

Error bodies: `{ "error": { "code": "…", "message": "…", "details": [] } }`. An
error MUST NOT contain a credential value, whatever the upstream echoed.

### 9.5 Entries list

`GET /v1/dictionaries/{id}/entries[?path=…][&format=text]` is the cheapest
complete view of a dictionary: one line per entry, nothing else. It exists for
the agent that would rather scan every name once than guess at search terms, and
for the consumer that wants to build its own `defer_loading` tool list
([§14.3](#143-anthropic-tool_reference-compatibility-mode)) without pulling the
whole catalog.

```json
{
  "kind": "entries",
  "dictionary": { "id": "crypto-data", "version": 47, "etag": "sha256:1c4f…" },
  "path": "tokens/price",
  "total": 2,
  "entries": [
    { "name": "token_market_cap", "title": "Token market cap", "path": "tokens/price" },
    { "name": "token_price", "title": "Token price", "path": "tokens/price" }
  ]
}
```

Rules:

- Canonical names only — aliases and tombstones do not appear.
- Sorted by `path`, then `name`, so the list reads like the catalogue.
- `risk` is present only when it is not `read`, exactly as at the `summary`
  detail level ([§11.1](#111-detail-levels)).
- `path` narrows to a subtree with the same rule search uses: the node itself and
  everything under `path/`. An unknown path returns `total: 0` with a 200, not a
  404 — the agent may have typed it.
- Text form (`format=text`), one line per entry, `[risk]` suffix only when
  present:

  ```
  DICTIONARY crypto-data v47 — 2 entries under "tokens/price"
  token_market_cap — Token market cap
  token_price — Token price
  ```

- Cacheable: carries the dictionary ETag, honours `If-None-Match`, and a
  `Cache-Control` of one minute.

The list is not budgeted ([§11](#11-response-budgets-and-detail-levels)); at
roughly 60 bytes per entry a thousand-entry dictionary is ~60 KB, and a consumer
that finds that too large narrows with `path`. Budgets exist to protect the
*per-turn* search round; this call is made once and cached.

### 9.6 Dictionary list

`GET /v1/dictionaries` answers "what is available, and how do I use it" in one
round. Each dictionary the caller may see carries its identity, its summary
(so a consumer — or a model — can choose among several), its endpoints, and the
list closes with a `usage` paragraph covering every loaded dictionary.

```json
{
  "dictionaries": [
    {
      "id": "crypto-data",
      "title": "Crypto data",
      "summary": "Token holders, prices and wallet PnL across Solana and EVM chains.",
      "version": 47,
      "etag": "sha256:1c4f…",
      "entryCount": 8,
      "loaded": true,
      "stale": false,
      "public": true,
      "execute": true,
      "endpoints": {
        "search": "https://dict.example.com/v1/dictionaries/crypto-data/search",
        "entries": "https://dict.example.com/v1/dictionaries/crypto-data/entries",
        "index": "https://dict.example.com/v1/dictionaries/crypto-data/index",
        "tool": "https://dict.example.com/v1/dictionaries/crypto-data/tool",
        "catalog": "https://dict.example.com/v1/dictionaries/crypto-data/catalog",
        "execute": "https://dict.example.com/v1/dictionaries/crypto-data/execute"
      }
    }
  ],
  "usage": "You have access to a tool dictionary covering Token holders, prices and wallet PnL across Solana and EVM chains. When a question needs data you do not have, search it before answering. …"
}
```

`title` and `summary` are `null` for a dictionary that is known but not yet
loaded; such a dictionary is also left out of `usage`. With several loaded
dictionaries `usage` names each one (`- id: title — summary`) and tells the
model to pick by summary; with none it says so rather than returning an empty
string a prompt would silently swallow.

Endpoints are absolute. The server derives them from its configured public base
URL, or — when none is configured — from the request's own scheme and host.

`execute` is `true` when this deployment executes this dictionary
([§9.7](#97-execute)); only then is `endpoints.execute` present. The `usage`
paragraph describes the execute loop when any listed dictionary executes.

### 9.7 Execute

`POST /v1/dictionaries/{id}/execute` runs one entry of the dictionary on the
caller's behalf. It exists so that an agent's loop can be *search → execute by
name* with nothing in between: no URL, no header, no credential ever reaches the
model.

Execution is **opt-in per deployment** and MAY be disabled per dictionary. A
server that does not execute answers `403 execution_disabled` and does not
declare `execute_tool` ([§14.5](#145-execute_tool)); such a server is exactly a
0.1 server.

#### 9.7.1 Request

```json
{
  "name": "holders_count",
  "params": { "address": "So11111111111111111111111111111111111111112", "excludeContracts": true },
  "maxBytes": 12000,
  "format": "json"
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | An entry name or alias, exactly as `search`/`entries` returned it. |
| `params` | yes | The entry's inputs, keyed as `input.properties` names them. `{}` when the entry has none. |
| `maxBytes` | no | Response budget, clamped exactly as for search ([§9.1](#91-search-request)). |
| `format` | no | `json` (default) or `text` ([§11.4](#114-text-rendering)). Also accepted as `?format=`. |

**Only catalogue entries execute.** The request carries no URL, method, header
or body template, and a server MUST ignore any such field if present. What is
called is decided by the dictionary; what is sent is decided by the validated
`params`; who is calling is decided by the credential the caller supplied.

The server:

1. Looks the entry up (aliases and tombstones as for `/entries/{name}`).
2. Validates `params` against the entry's `input` schema, filling declared
   `default`s. A mismatch is `400 invalid_params` with one `details` item per
   violation (`at`, `keyword`, `message`); the upstream is not called.
3. Renders the descriptor ([§5.5](#55-variables)): method, `baseUrl` +
   `urlTemplate`, `query`, `headers`, `bodyTemplate`, with inputs URL-encoded
   where they land in the URL.
4. Fills `{{VARIABLE}}` references from the deployment's configured variables —
   except the one behind `auth.value`, which comes from the caller
   ([§9.7.4](#974-the-callers-credential)).
5. Checks the resolved origin against the origins the dictionary declares
   ([§16.1](#161-what-the-service-may-call)).
6. Performs the call with a deadline of `min(timeoutHintMs, server cap)`,
   without following redirects, reading at most the server's upstream byte cap.
7. Returns the result under the response budget.

#### 9.7.2 Response

`200` whenever the upstream answered, **whatever its status**: an upstream 404 is
a result the agent needs to read, not a service fault.

```json
{
  "kind": "result",
  "dictionary": { "id": "crypto-data", "version": 47, "etag": "sha256:1c4f…" },
  "tool": "holders_count",
  "status": 200,
  "contentType": "application/json; charset=utf-8",
  "body": { "count": 1234 },
  "bodyFormat": "json",
  "bytes": 14,
  "truncated": false,
  "elapsedMs": 212,
  "budget": { "maxBytes": 12000, "usedBytes": 287, "truncated": false }
}
```

| Field | Meaning |
|---|---|
| `status` | The upstream HTTP status. Also sent as the `X-Upstream-Status` header. |
| `contentType` | The upstream `Content-Type`, or `null`. |
| `body` | The upstream body: parsed JSON when the content type says JSON and the whole body was read; otherwise text. |
| `bodyFormat` | `json` or `text` — what `body` is. |
| `bytes` | Upstream bytes received, after the upstream read cap. |
| `truncated` | `true` when `body` is shorter than what the upstream sent — cut by the read cap, or by the response budget. |
| `elapsedMs` | Upstream round-trip time. |
| `budget` | As for search ([§11.5](#115-budget-accounting)): `usedBytes` is the byte length of this very response. |

When the response would exceed `maxBytes`, `body` becomes text cut on a
code-point boundary to fit exactly, ending in `…`, with `bodyFormat: "text"`,
`truncated: true` and `budget.truncated: true`. A consumer therefore always gets
a well-formed JSON document within budget, and always knows when it did not get
everything. Nothing is ever paginated on the agent's behalf: the agent asks for
less (narrower inputs, a smaller page) — the prompt of
[§14.2](#142-system-prompt-guidance) says so.

Headers: `Cache-Control: no-store`, `X-Budget-Used-Bytes`, `X-Budget-Truncated`,
`X-Upstream-Status`. Results are never cached by the service and never carry an
ETag.

With `format: "text"` the body is `text/plain`: one header line, then the body
as-is (JSON pretty-printed, two-space indent):

```
holders_count → 200 application/json (14 bytes)
{
  "count": 1234
}
```

The header line reads `<tool> → <status> <media type> (<bytes> bytes)`, with
`, truncated` after the byte count when `truncated` is true. The media type is
the `Content-Type` without parameters; the whole ` <media type>` segment is
absent when the upstream sent none.

#### 9.7.3 Execution errors

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_params` | `params` is not an object, does not satisfy the input schema, misses a required placeholder, or renders an unusable URL. `details` names the field. |
| 401 | `missing_credential` | The entry declares a caller-held credential and the request carried none. `details[0].headers` lists the header names the server accepts it in. |
| 403 | `execution_disabled` | This deployment or this dictionary does not execute. |
| 404 | `entry_not_found` / `entry_removed` | As for `/entries/{name}`. |
| 422 | `not_executable` | The entry is an `mcp` or `local` call. This specification defines execution for `http` calls only. |
| 500 | `missing_variable` | A `{{VARIABLE}}` the deployment did not configure. A deployment fault, never the agent's; the message names the variable. |
| 502 | `target_not_allowed` | The resolved origin is not one the dictionary declares ([§16.1](#161-what-the-service-may-call)). Nothing was sent. |
| 502 | `upstream_redirect` | The upstream answered 3xx. Redirects are not followed; the `Location` is not disclosed. |
| 502 | `upstream_error` | The upstream could not be reached (DNS, TLS, connection). |
| 504 | `upstream_timeout` | The deadline passed. `details[0].timeoutMs` is the deadline that applied. |

#### 9.7.4 The caller's credential

The philosophy of [§16.2](#162-no-credentials-ever) does not bend: the service
holds no credential at rest, and a dictionary still carries only a variable
*name*. What changes is that the caller may hand the service a credential
**for the duration of one request**, and the service copies it into the one
place the descriptor says it goes.

For an entry whose effective `auth` is `kind: "caller"` with a placement
(`in`/`name`/`value: "{{NAME}}"`), the server reads the value from the incoming
request, in this order:

1. The header `X-Td-Var-<name>` (name lower-cased, e.g.
   `x-td-var-crypto_data_api_key`) — explicit, and the only form for a
   credential the descriptor places in the query string.
2. When `in` is `header`: the header the descriptor itself names (e.g.
   `x-api-key`), so that a caller can simply send the upstream's own header.
   A literal prefix in `auth.value` (`"Bearer {{TOKEN}}"`) is stripped from the
   supplied value when present, so `Authorization: Bearer xyz` is forwarded once,
   not doubled.

Absent both, `401 missing_credential`. A server MUST NOT store the value, MUST
NOT log it, and MUST redact it from anything it returns — result bodies and
error messages alike — even when the upstream echoed it back. Every other
`{{VARIABLE}}` (a region, a tenant slug: non-secret by
[§5.5](#55-variables)) comes from deployment configuration, never from the
request, so a caller cannot repoint a call by supplying a variable.

For `auth.kind: "none"` no credential is read and none is forwarded.

### 9.8 Service-level routes and the request envelope

**Service-level routes.** `/v1/search` (POST and GET), `/v1/execute`,
`/v1/entries` and `/v1/tool` behave exactly like their `/v1/dictionaries/{id}/`
forms, with the dictionary taken from a `dictionary` argument (body field, or
query parameter on GET). When it is absent:

* exactly one dictionary is visible to the caller → that one;
* none → `404 not_found`;
* several → `400 dictionary_required`, with `details[0].dictionaries` listing
  the ids, so a model that guessed wrong can pick from the list.

The per-dictionary routes also accept `dictionary`; it MUST equal the path id or
the answer is `400 dictionary_mismatch`. This lets one tool declaration serve
both a single-dictionary consumer, which never sends it, and a multi-dictionary
one, which always does.

**Envelope.** Agent runtimes commonly forward a tool call as one object:

```json
{ "tool": "execute_tool", "input": { "name": "holders_count", "params": { "address": "…" } }, "chatId": "…", "callId": "…" }
```

Every POST route (`search`, `execute`, `entries:batchGet`) MUST accept both the
bare arguments and this envelope. The rule is mechanical: when none of the
route's own top-level fields is present and `input` is an object, `input` is the
request. A body that carries a real argument at the top level is taken as-is,
so an argument that happens to be named `input` is never misread. Fields outside
`input` (`tool`, `chatId`, `callId`, `chatObject`, …) are ignored, never echoed.

---

## 10. Search semantics

### 10.1 What is searched

At minimum: `name`, `title`, `summary`, `keywords`, `description`, `path`
segments, input property names, and input property descriptions. (Anthropic's
implementation searches names, descriptions, argument names and argument
descriptions; this is that set plus keywords, title and path, which exist
precisely to be searched.)

RECOMMENDED field weights for a BM25 backend, as a starting point:

| Field | Weight |
|---|---|
| `keywords` | 3.0 |
| `name` | 2.5 |
| `title` | 2.0 |
| `summary` | 1.5 |
| `path` | 1.2 |
| input property names | 1.0 |
| `description` | 0.8 |
| input property descriptions | 0.5 |

### 10.2 Normalization and synonyms

Before matching, both the query and the indexed text MUST be:
lower-cased; `snake_case`, `camelCase` and `kebab-case` split into words
(`holders_count` → `holders count`, and the original kept); punctuation stripped;
a small English stopword list removed *from the query only*.

The dictionary's `synonyms` map is then applied as query expansion, in both
directions. Stemming is OPTIONAL and, if used, MUST be light (plural folding);
aggressive stemming ruins short technical terms.

### 10.3 Ranking

Backends differ; the contract is only:

1. Results MUST be sorted by descending `score`.
2. `score` MUST be comparable **within one response** only. It is a hint to the
   agent, not a cross-query metric.
3. `matchedOn` MUST list which fields contributed, so a human can debug ranking
   without reading the index.
4. A `deprecated` entry MUST be demoted below any non-deprecated entry with a
   non-trivial score, and MUST carry its `successor` in `related`.
5. An entry that matches *more of the question* SHOULD outrank one that matches
   a part of it more loudly. Agents ask in sentences ("how many wallets hold a
   token"), and a term-frequency score alone rewards the entry that repeats two
   of those words in every field over the one that answers all three.

### 10.4 The relevance threshold

A server MUST define a minimum score below which a result is not returned. If
*no* result clears it, the response is an index with `reason: "below_threshold"`
— not a list of bad matches. Returning four irrelevant tools is worse than
returning none, because the model will call one of them.

The threshold MUST be configurable per dictionary and its effective value
reported in `/v1/health`.

### 10.5 Pluggable backends

The search backend is an implementation detail behind this interface:

```ts
interface SearchBackend {
  index(entries: Entry[]): Promise<void>;
  search(query: string, opts: { limit: number; path?: string }): Promise<Hit[]>;
  close(): Promise<void>;
}
// Hit = { name: string; score: number; matchedOn: string[] }
```

The reference implementation ships BM25 (cheap, debuggable, zero external
dependencies, no embedding cost or latency). An embedding backend implements the
same interface and changes nothing else — not the wire format, not the entry
schema. A hybrid backend (BM25 ∪ vector, reciprocal-rank fusion) is the expected
next step; the format already carries everything it would need.

Relations and index fallback are **not** part of the backend. They are applied by
the server around whatever the backend returns, so every backend gets them.

---

## 11. Response budgets and detail levels

The consumer showed the model at most 16,000 characters of tool result. The format
therefore treats response size as a first-class, enforced constraint rather than
an afterthought.

### 11.1 Detail levels

| Level | Carries |
|---|---|
| `ref` | `name` only. (Plus `score`.) |
| `summary` | `name`, `title`, `summary`, `path`, `score`, `matchedOn`, `relations` **as `{type,target,reason}` only, strongest first and at most 5**, and `risk`/`stability` **when they are not the default** |
| `full` | Everything at `summary`, plus `description`, `input`, `returns`, `call`, `examples`, `cost`, and `risk`/`stability` unconditionally |

`risk` and `stability` survive down to `summary` only when they are *not* `read`
and `stable`. A model choosing between five summarized results must not have to
spend a round to discover that one of them writes, or is deprecated; and because
the default case stays absent, the common page pays nothing for the rule.

### 11.2 `auto`

`auto` is the default, and the reason a single round suffices:

* the top **3** results are rendered at `full` — enough to call immediately,
* results 4…`limit` at `summary`,
* every `related` item at `summary`.

The server then applies [§11.3](#113-degradation-order). A consumer that wants
predictable output asks for an explicit level; an agent should not have to.

### 11.3 Degradation order

When the serialized response would exceed `maxBytes`, a server MUST reduce it in
this order, stopping as soon as it fits, and MUST report what it did in `notice`
with `budget.truncated: true`:

1. Drop `examples` from `full` results.
2. Truncate `description` to 300 chars.
3. Demote `full` results to `summary`, from the lowest-ranked upward, never
   demoting rank 1 below `full`.
4. Drop `related` items beyond the first 3.
5. Drop results from the tail, emitting a `nextCursor`.
6. Drop `related` entirely.
7. If rank 1 alone at `full` still does not fit — a pathological entry — return it
   at `summary` with `notice` explaining that its schema exceeds the budget and
   naming `/entries/{name}` as the way to fetch it.

Rank 1 at `full` is protected until the last step, because the whole point is to
return something callable.

A server MUST NOT emit a response larger than `maxBytes`. It MUST measure the
serialized bytes, not estimate them.

### 11.4 Text rendering

`format: "text"` returns `text/plain; charset=utf-8` instead of JSON. Consumers
that inline the raw response into a prompt pay for every brace and repeated key
in JSON; this form carries the same decisions in fewer bytes — measured on the
conformance vectors, **25–42 % fewer**, and ~40 % on the case that matters most,
a full-detail page of callable definitions. The saving in *tokens* is larger
than the saving in bytes, because JSON punctuation tokenizes badly.

This rendering is **normative to the byte**. A consumer is expected to assert on
it, so it is specified as a grammar rather than as an example, and this
specification ships conformance vectors — `conformance/text/*.txt` with the
response that produced each one in the sibling `*.json` — to diff against.
Changing the rendering means changing this section and those vectors in the same
commit.

#### 11.4.1 Common rules

* UTF-8, no BOM. Lines are joined with LF (`U+000A`). The body does **not** end
  with a trailing line break: its last byte is the last byte of the closing
  instruction.
* `IND`, the indent unit, is exactly three spaces (`U+0020` ×3). Nesting repeats
  `IND`.
* `—` is EM DASH (`U+2014`) with exactly one space on each side wherever it
  separates two fields.
* `<q:x>` is `x` rendered as a JSON string **including its quotes**, escaped per
  RFC 8259. `<json:x>` is `x` rendered as compact JSON (no spaces after `:` or
  `,`). Everything else is emitted verbatim: never truncated, never re-wrapped,
  never escaped. A value containing a line break would break the grammar, so
  entry text MUST NOT contain one.
* A blank line is an empty line — an LF with nothing before it.
* A section with no content is omitted **entirely, heading included**. There are
  no empty headings and no placeholders for absent fields.
* Fields the response does not carry at its detail level ([§11.1](#111-detail-levels))
  are simply absent from the rendering.
* `budget` is not rendered. The counters travel in the `X-Budget-Used-Bytes` and
  `X-Budget-Truncated` response headers, and any degradation that occurred is
  already stated in `notice`, which the `NOTE:` line carries.

#### 11.4.2 Results (`kind: "results"`)

```
DICTIONARY <id> v<version> — <n> result[s] for <q:query.text>
[NOTE: <notice>]
<blank>
<result>                                  ← one block per result, in rank order
<blank>                                   ← one blank line after every result block
[RELATED
<related>…
<blank>]
[MORE: pass cursor <q:nextCursor> to continue.
<blank>]
<closing instruction>
```

`<n> result` when `n` is 1, `<n> results` otherwise (including `0 results`). The
`NOTE:` line appears only when `notice` is non-null.

A `<result>` block, where `i` counts from 1:

```
<i>. <name> — <title>
[IND<summary>]
[INDDEPRECATED | INDBETA]                 ← when `stability` is present and not "stable"
[INDRISK: <risk>]                         ← when `risk` is present and not "read"
[INDBRIEF of <briefOf>: the same answer in a compact response; prefer this one]
[INDBRIEF: <brief> answers this compactly; prefer it unless you need the full data]
[INDpath: <path>]
── the next seven lines only when `detail` is "full" ──
[IND<description>]
INDinput: <property 0>
[IND+7 spaces<property n>]…               ← aligned under the first property
[INDreturns: <returns>]
[INDcall: <call>]
[INDcost: <tier>[ — <note>]]
[INDexample: <json:input>[  (<note>)]]…   ← two spaces before the note
── end of the `full`-only lines ──
[INDsee also: <target> (<type>) — <reason>]…   ← relations, strongest first, ≤ 5
```

The warning lines come before the facts on purpose: whatever makes a tool the
wrong choice should be read before the model has finished reading how to call it.

A `<property>` is `<name> (<facets>)[ — <description>]`. Facets are joined with
`, ` in this fixed order, each omitted when it does not apply: `<type>`,
`one of <enum joined with |>`, `required`, `default <json:value>`. When the input
schema has no properties, the single property line is the literal
`(takes no input)`.

A `<call>` depends on its type:

| Type | Rendering |
|---|---|
| `http` | `<METHOD> <baseUrl><urlTemplate>[?<k>=<v>[&<k>=<v>]…][  (auth: <auth>)]` |
| `mcp` | `MCP <server> :: <tool>` |
| `local` | `local handler <handler>` |

`baseUrl` is the effective one ([§5.4](#54-the-call-descriptor)) and is omitted
when there is none. The auth suffix — two spaces, then the parenthesis — appears
only when `auth.kind` is `caller`. `<auth>` is the `hint` when there is one,
else `<name> <in>` (`x-api-key header`) when there is a placement, else
`supplied by caller`. Both placeholder kinds, `{param}` and `{{VARIABLE}}`,
render verbatim: the agent needs to see the shape of the call, and a
credential never appears here because one never appears in the document
([§16.2](#162-no-credentials-ever)).

A `<related>` item:

```
IND- <name> — <title>
[IND+2 spaces<summary>]
[IND+2 spaces(<via.type> to <via.from>: <via.reason>)]
```

The closing instruction is REQUIRED, fixed, and two lines — it is the only place
the agent is told what to do next:

```
To use one, call it with the input shown. To see the full definition of any of
these, search again with its exact name.
```

#### 11.4.3 Index (`kind: "index"`)

```
DICTIONARY <id> v<version> — index
NOTE: <notice>
[<blank>
DID YOU MEAN
IND<name> — <title>  (<why>)…]            ← two spaces before the parenthesis
<blank>
CATEGORIES
<node>…                                   ← roots at depth 0
<blank>
Search again with one of the "try" queries, or with a path to narrow to one branch.
```

A `<node>` at depth `d`, where `PAD` is `IND` repeated `d` times:

```
PAD<path>[ (<entryCount>)][ [unavailable]] — <title>: <summary>
[PADINDtry: <q:query>[, <q:query>]…]
[PADINDe.g. <example>[, <example>]…]
<child>…                                  ← rendered at depth d+1
```

`[unavailable]` marks a node whose branch failed to load ([§8.1](#81-resolution)):
the subtree is announced rather than silently dropped, so the agent knows the
catalogue is incomplete rather than concluding the tools do not exist. The final
instruction line is REQUIRED and fixed.

#### 11.4.4 Worked examples

Results, from `conformance/text/05-results-mcp-and-local.txt`:

```
DICTIONARY vectors v4 — 2 results for "probe echo debug"

1. echo_request — Echo a request back
   Return the request exactly as the service received it, for debugging a caller.
   path: diagnostics
   input: text (string, required) — Anything; it comes back unchanged.
   call: local handler diagnostics.echo
   cost: free

2. probe_upstream — Probe the upstream feed
   Report whether the price feed is live and how far behind it is.
   path: diagnostics/probe
   input: (takes no input)
   returns: Liveness plus the age in seconds of the newest price.
   call: MCP market-ops :: probe_feed
   cost: free

To use one, call it with the input shown. To see the full definition of any of
these, search again with its exact name.
```

An index, from `conformance/text/06-index-empty-query.txt`:

```
DICTIONARY vectors v4 — index
NOTE: Empty query. This is the catalogue of what this dictionary covers; search with one of the "try" queries.

CATEGORIES
alerts (3) — Price alerts: Create, list and delete alerts that fire when a token crosses a price.
   try: "tell me when a token goes above a price", "delete an alert"
   e.g. alert_create, alert_delete
diagnostics (2) — Diagnostics: Tools that report on the service itself rather than on market data.
   try: "is the service healthy"
   diagnostics/probe (1) — Probes: Liveness and version checks reached over MCP.
      try: "probe the upstream"

Search again with one of the "try" queries, or with a path to narrow to one branch.
```

The vectors are the authority, not these excerpts: the first one here is the real
file with one `description` shortened so it fits the page width.

### 11.5 Budget accounting

`budget.usedBytes` MUST be the byte length of the response body actually sent.
This makes overruns a test assertion rather than a theory.

---

## 12. Empty and no-match queries

**A search MUST NOT return an empty result list, and MUST NOT return an error for
a query that simply did not match.** It returns the index.

| Situation | Response |
|---|---|
| `query` absent or empty | `kind: "index"`, `reason: "empty_query"`, full index to depth 2 |
| No hit clears the threshold | `kind: "index"`, `reason: "below_threshold"`, plus `suggestions` |
| Hits exist but `path`/`risk` filters removed them all | `kind: "index"`, `reason: "no_match"`, index **restricted to the filtered subtree**, plus a `notice` naming the filter |
| Unknown `path` filter | `kind: "index"`, `reason: "no_match"`, full index, `notice` naming the unknown path |

The rationale is that an empty list teaches the agent nothing and burns a round.
The index teaches it the vocabulary of the dictionary, and `sampleQueries` hands
it a query that is known to work. A miss should be *the most informative response
the service ever gives*, because it is the only moment the agent has admitted it
does not know what is there.

### 12.1 Index depth under budget

The index is depth-limited to fit `maxBytes`: depth 2 by default, dropping to
depth 1 and then to top-level `title` + `summary` + `entryCount` only. When a
`path` filter is present, the subtree at that path is expanded one level deeper
than the rest, since that is where the agent was looking.

### 12.2 Suggestions

On `below_threshold`, a server SHOULD attach up to 5 `suggestions`: near-miss
entries found by a fuzzy pass (trigram or edit distance over `name`, `title` and
`keywords`) that did not clear the ranking threshold. Each carries `why` — the
term it nearly matched. This is how `"hodl statistics"` reaches `holders_count`
in one round instead of two.

---

## 13. Versioning, ETags and caching

### 13.1 Two versions, never conflated

* `toolDictionary` — the **spec** version. Semver-ish, `"0.1"`. Changes when this
  document changes.
* `version` — the **content** version. A monotonically increasing integer. Changes
  whenever the content changes.

### 13.2 ETag

`ETag` MUST be `"sha256:<hex>"` over the **canonical** serialization of the
document: JSON Canonicalization Scheme (RFC 8785) — keys sorted, no insignificant
whitespace, canonical number formatting. Canonicalization is required so that two
servers holding the same content compute the same ETag, which is what makes a
mirrored or cached dictionary verifiable rather than merely fresh.

* `GET /catalog` MUST send `ETag` and honour `If-None-Match` with `304`.
* `GET /index`, `/entries/{name}` and `GET /search` SHOULD send an ETag derived
  from the document ETag plus the request parameters.
* `POST /search` does not use ETags but MUST echo the document ETag in
  `dictionary.etag`, so a consumer can tell whether two answers came from the
  same dictionary.

### 13.3 Freshness: pull, never register

A consumer is given **one URL**, not a copy. Registering a static snapshot is
rejected by design: the day someone forgets to re-register, the dictionary is
silently stale and every answer built on it is wrong in a way nobody notices.

* `GET /version` returns `{ "id", "version", "etag", "entryCount", "generatedAt" }`
  and is designed to be polled. It MUST be cheap (no serialization of entries).
* Servers MUST send `Cache-Control: max-age=<n>, must-revalidate` on `/catalog`.
  `n` SHOULD be small (≤ 300 s).
* A server whose dictionary came from a `source` URL MUST re-pull on the
  configured interval and MUST serve the last good version if a pull fails,
  reporting `stale: true` and `staleSince` in `/version` and `/health`.
* A server MUST NOT serve a dictionary that failed validation. A failed refresh
  keeps the previous valid one. Silent partial loads are forbidden.

### 13.4 Renaming and removal

An entry `name` is a contract: it appears in conversation history and in tenant
configuration.

* Renaming an entry MUST keep the old name in `aliases`. `/entries/{name}` MUST
  resolve aliases, and search MUST match them.
* Removing an entry SHOULD first mark it `deprecated` with a `successor`
  relation, for at least one content version.
* A removed name MUST NOT be reused for different behaviour. `/entries/{name}`
  for a removed name returns 404 with
  `{"error": {"code": "entry_removed", "details": [{"removedInVersion": 46}]}}`
  rather than a bare 404, so the consumer can tell "never existed" from "went
  away".

---

## 14. The agent-facing tool

The model sees exactly one tool. This is its canonical declaration:

```json
{
  "name": "search_tools",
  "description": "Find the API tools that can answer the current question. Search with the words the user used — plain language works better than technical names. You get back a few matching tools with their inputs and the endpoint to call, plus related tools that answer nearby questions. If nothing matches, you get the catalogue of what this dictionary covers, with example searches; search again with one of those.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "What you are looking for, in plain language. Empty to see the catalogue."
      },
      "limit": {
        "type": "integer",
        "description": "How many tools to return. Default 8, max 50.",
        "minimum": 1,
        "maximum": 50
      },
      "path": {
        "type": "string",
        "description": "Optional category path from the catalogue, e.g. \"tokens/holders\", to search only inside it."
      },
      "dictionary": {
        "type": "string",
        "description": "Optional dictionary id. Only needed when several dictionaries are available; when given it must be the one this endpoint serves."
      }
    },
    "required": ["query"]
  },
  "endpoint": "https://<host>/v1/dictionaries/<id>/search",
  "method": "POST"
}
```

Where the deployment executes ([§9.7](#97-execute)) the phrase "and the endpoint
to call" in the description becomes "— pass those to execute_tool by name —":
the model is never pointed at an endpoint it cannot use.

Notes on what is deliberately *absent* from the model-facing surface: `detail`,
`maxBytes`, `format`, `cursor`, `includeRelated`, `risk`. Every one of those is a
knob the model would get wrong, and the server has a better default for all of
them. They stay available to the integrator via the API. `dictionary` is the one
routing argument the model gets, because only the model knows which dictionary
the question is about ([§9.8](#98-service-level-routes-and-the-request-envelope)).

### 14.1 One tool or two

A consumer MAY additionally expose `list_tools(path?)`, mapping to
`GET /entries` ([§9.5](#95-entries-list)):

```json
{
  "name": "list_tools",
  "description": "List every tool in this dictionary as one line each: name and title. Use it when you want the complete picture rather than a search, or to pick a name to look up. Pass a category path to list only that part.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Optional category path, e.g. \"tokens\", to list only that subtree."
      }
    }
  },
  "endpoint": "https://<host>/v1/dictionaries/<id>/entries",
  "method": "GET"
}
```

It is the right second tool for a model that reasons better from a complete
list of names than from a ranked guess — small dictionaries, or an agent that
has been told what the dictionary covers and wants to see it all once. Its cost
is one round plus the list's bytes; on a large dictionary a consumer SHOULD
prefer `search_tools` alone.

A `get_tool(name)` mapping to `/entries/{name}` is also allowed and SHOULD be
omitted where rounds are scarce: `auto` detail already returns callable
definitions, so it only earns its context cost when the agent routinely needs
more than three full definitions.

Every declaration carries `endpoint` and `method` so the executor — not the
model — knows how to make the call.

### 14.2 System prompt guidance

Non-normative, but implementations SHOULD ship this text with the tool:

> You have access to a tool dictionary covering *{dictionary.summary}*. When a
> question needs data you do not have, search it before answering. Search with
> the user's own words. Read the "see also" lines: they frequently name the tool
> you actually wanted. When a tool has a BRIEF, call the brief: it answers the
> same question in a response that fits your context; use the full tool only
> when you need all of its data. If you would rather see everything at once,
> list the tools; each line is a name you can search for exactly.

The last sentence is present only when `list_tools` is exposed. When
`execute_tool` is exposed the paragraph continues:

> Once a search shows the tool you need, run it with execute_tool: pass its
> exact name and the inputs its schema lists — you never need a URL or a key.
> If the result says it was truncated, ask for less (narrower inputs, a smaller
> page) rather than assuming the rest. If it reports a missing input, search
> again or read the tool's inputs before retrying.

and the multi-dictionary form of [§9.6](#96-dictionary-list) adds "Name the
dictionary in every call when more than one could apply."

### 14.3 Anthropic `tool_reference` compatibility mode

With `format: "anthropic_tool_reference"`, the response body is:

```json
{ "content": [ { "type": "tool_reference", "tool_name": "holders_count" } ] }
```

so that a caller using Anthropic's custom tool search path can forward `content`
verbatim as the `tool_result` content. This requires the caller to have every
referenced tool defined in its own `tools` array with `defer_loading: true` —
which it can generate from `/catalog`. In this mode `related` entries ARE included
as additional `tool_reference` blocks (capped at 3), because the whole relation
mechanism would otherwise be invisible to that caller; the `reason` text is lost,
which is a real loss and the reason this mode is not the default.

### 14.4 Served, not copied

A consumer should not have to transcribe this section. `GET
/v1/dictionaries/{id}/tool` returns the **agent bundle**: the declarations of
[§14](#14-the-agent-facing-tool) and [§14.1](#141-one-tool-or-two) with their
`endpoint`s filled in for this server, and the prompt paragraph of
[§14.2](#142-system-prompt-guidance) with this dictionary's summary filled in.

```json
{
  "dictionary": { "id": "crypto-data", "version": 47, "etag": "sha256:1c4f…", "title": "Crypto data", "summary": "…", "entryCount": 8 },
  "tools": [ { "name": "search_tools", … }, { "name": "list_tools", … }, { "name": "execute_tool", … } ],
  "systemPrompt": "You have access to a tool dictionary covering …",
  "execute": true
}
```

`execute` says whether `execute_tool` is in `tools`; it is `false`, and the
tool absent, on a deployment that does not execute this dictionary. `GET
/v1/tool?dictionary=…` serves the same bundle by service-level route
([§9.8](#98-service-level-routes-and-the-request-envelope)).

A consumer that fronts several dictionaries fetches one bundle per dictionary
and MUST make the tool names unique before handing them to a model — e.g.
`search_tools_crypto_data` — or expose a single `search_tools` with a
`dictionary` argument that it routes itself. The `usage` paragraph of
[§9.6](#96-dictionary-list) is written for that multi-dictionary prompt.

The bundle carries the dictionary ETag and honours `If-None-Match`; it changes
only when the dictionary does.

### 14.5 `execute_tool`

Declared only where the deployment executes the dictionary ([§9.7](#97-execute)):

```json
{
  "name": "execute_tool",
  "description": "Run one tool from this dictionary by name and get its result. Use the exact \"name\" a search returned and give \"params\" matching that tool's inputs. The result is the API's own answer (JSON when it is JSON), cut to a size budget when large; \"truncated\" tells you when it was. Errors name the input or credential that was missing.",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "The tool name exactly as search_tools or list_tools returned it."
      },
      "params": {
        "type": "object",
        "description": "The tool's inputs, keyed as its input schema names them. Omit inputs that are optional and unknown."
      },
      "dictionary": {
        "type": "string",
        "description": "Optional dictionary id. Only needed when several dictionaries are available; when given it must be the one this endpoint serves."
      }
    },
    "required": ["name", "params"]
  },
  "endpoint": "https://<host>/v1/dictionaries/<id>/execute",
  "method": "POST"
}
```

With it the model's loop closes without a URL ever entering the context:
`search_tools` returns names and input schemas, `execute_tool` takes a name and
inputs. The executor — the consumer's own backend, which holds the caller's
credential — forwards the model's arguments and attaches the credential per
[§9.7.4](#974-the-callers-credential). Consumers that fronted 0.1 by giving
the model `endpoint`s to call themselves can keep doing so; the two loops are
compatible, and the same result shape ([§9.7.2](#972-response)) is what an
executor of either kind should hand back to the model.

---

## 15. Generation, overlays and provenance

### 15.1 Generated, not hand-written

A hand-written catalog of 600 endpoints is wrong within a month. A dictionary
SHOULD be generated from the source service's own route registry or OpenAPI
document, on every build.

From OpenAPI, the mapping is:

| Dictionary | OpenAPI |
|---|---|
| `name` | `operationId`, normalized to the name charset; else `<method>_<plain path segments>`, with the path parameters spelled out (`get_pool_by_chain_by_address`) only when the short form is ambiguous |
| `title` | `summary` when it fits the 80-character limit, else derived from `operationId` or the path — a `summary` written as a whole sentence is a bad title and a good summary, and truncating it would throw away both |
| `summary` | first sentence of `description` when it says more than `title`, else `summary` |
| `description` | `description` |
| `path` | first `tag`, slugified; nested via `x-category` if present |
| `keywords` | seeded from: tags, path segments, `operationId` word split, parameter names, and the nouns in `summary` |
| `input` | parameters + requestBody schema, merged into one object schema |
| `call` | `method`, server URL, path template, parameter locations |
| `defaults.auth`, `call.auth`, `defaults.variables` | `security` per operation (falling back to the document's): `apiKey` in header/query → placement on that name; `http` bearer, `oauth2`, `openIdConnect` → `Authorization: Bearer {{<ID>_TOKEN}}`; `http` basic → `Authorization: Basic {{<ID>_BASIC_AUTH}}`; `apiKey` in cookie → `hint` only. The scheme most operations use becomes `defaults.auth`; the others override per entry; an operation with `security: []` gets `kind: none`. Only referenced variables are declared, all `secret: true`, described from the scheme |
| `returns` | `responses.2xx.description`, unless it is a placeholder (`Default Response`, `OK`) — then a one-line description of `responses.2xx.content` schema, naming its top-level fields |
| `risk` | `get`/`head` → `read`; `post`/`put`/`patch` → `write`; `delete` → `destructive` |
| `relations` | seeded from: same category and same resource (first path segment), or same category and same required inputs, → `pairs_with`, weak and capped; `deprecated: true` → `successor` if `x-replaced-by` resolves |

Prose harvested from the document is markdown; the text rendering
([§11.4](#114-text-rendering)) is not. Emphasis markers, inline code and link
syntax MUST be stripped, and every harvested field MUST be clamped to its schema
limit — a document that does not validate is not a document.

A `deprecated` operation with no resolvable `x-replaced-by` MUST still satisfy
[§17.1](#171-a-conforming-dictionary) rule 7: the generator writes a
`deprecation.note` saying there is no declared replacement, and the overlay is
where a human names the real one.

Everything in that table is a *seed*. Seeded keywords are mechanical and seeded
relations are weak — in particular, a generator cannot know that `holders_count`
and `holders_percentage` are alternatives rather than merely adjacent. That is
what the overlay is for.

The seeding is deliberately unwilling to guess at scale: when a group that would
be related mechanically is larger than eight entries, the generator relates none
of them and says so, because four arbitrary picks out of forty are worse than
none.

### 15.2 Overlays

An overlay is a separate file, hand-maintained, keyed by entry name. It may also
carry document-level knowledge the generator cannot derive — the `synonyms` map
above all, plus `title`, `summary` and `defaults`:

```json
{
  "toolDictionaryOverlay": "0.1",
  "dictionaryId": "crypto-data",
  "entries": {
    "holders_count": {
      "summary": "Number of distinct wallets currently holding a token.",
      "keywords": { "add": ["how many holders", "hodlers"], "remove": ["statistics"] },
      "relations": { "add": [
        { "type": "alternative", "target": "holders_percentage", "reason": "share of supply per holder, not a count" }
      ] }
    }
  },
  "index": {
    "tokens/holders": { "summary": "Who owns a token and in what proportion.", "sampleQueries": ["who holds this token"] }
  },
  "addIndex": [
    { "path": "tokens/pricing", "title": "Pricing", "summary": "What a token costs.", "sampleQueries": ["price of a token"] }
  ],
  "synonyms": { "holders": ["holder count", "how many wallets"] },
  "hide": ["internal_debug_dump"]
}
```

| Overlay key | Applies to | Effect |
|---|---|---|
| `title`, `summary`, `defaults` | the dictionary | replace / shallow-merge (`defaults`): an overlay `defaults.variables` or `defaults.auth` replaces the generated one wholesale, so it must be complete |
| `synonyms` | the dictionary | merged; an overlay group wins on the same canonical term |
| `entries."*"` | every entry | the same patch shape, applied to all entries before any named patch |
| `entries.<name>` | one entry | scalars replace; `keywords`, `aliases`, `relations` take the patch form |
| `index.<path>` | one index node | `title`/`summary` replace; `sampleQueries`, `examples` take the patch form |
| `addIndex` | the index | adds nodes the generator did not produce, so `entries.<name>.path` can move entries under them |
| `hide` | the dictionary | removes entries, and every relation and index example pointing at them |

Merge rules, which MUST be deterministic:

* The entry key `"*"` is not a name: it patches **every** entry, and is applied
  before any named patch, so a named patch overrides it. It is what makes a
  catalog-wide edit — dropping the keyword the generator put on all 500 entries,
  marking a whole surface `beta` — one edit instead of 500 identical ones. It is
  never reported as a stale key.
* Scalar fields in the overlay **replace** the generated value.
* List fields take `{ "add": [...], "remove": [...] }`; `remove` is applied
  first, then `add`, then duplicates collapse. A bare array replaces the list
  outright. `relations.remove` matches by `target`, narrowed by `type` when the
  removal entry gives one.
* Applying an overlay twice MUST produce the same dictionary as applying it once.
* `hide` removes entries from the dictionary entirely (they are still generated,
  so a later un-hide is free), along with every relation that targeted them and
  every index `examples` mention — a dangling reference to a hidden entry would
  fail [§17.1](#171-a-conforming-dictionary) rule 2.
* Index `sampleQueries` and `examples` are **derived** from the entries in each
  node, so they MUST be re-derived after the entry patches and `hide` are
  applied — an overlay that moves an entry to another `path` moves it in the
  index too, and one that hides the last entry in a category leaves no examples
  behind. A node's field is exempt exactly when the overlay set it: a key
  present in `index.<path>` or in the `addIndex` node is the author's and is
  left alone. `examples` name a node's **own** entries, never a descendant's.
* An overlay key naming an entry or node that no longer exists is a **validation
  error, reported but non-fatal** — it is the signal that an upstream rename happened,
  and swallowing it silently is how overlays rot.

The result MUST be validated ([§17.1](#171-a-conforming-dictionary)) before it is
published: a generator run either produces a servable catalog or fails loudly.
`version` SHOULD be bumped only when the content actually changed — compare the
canonical form of everything except `version`, `generatedAt` and `sources`, so a
rebuild that found nothing new does not invalidate every consumer's cache.

Generation is therefore `generate(openapi) + overlay = dictionary`, repeatable on
every build, with human knowledge preserved across regenerations. This is the
answer to "hand-written goes stale" and "generated is too dumb" at the same time.

### 15.3 Provenance

```json
"sources": [
  {
    "type": "openapi",
    "url": "https://data.example.com/openapi.json",
    "fetchedAt": "2026-09-15T18:19:40Z",
    "etag": "W/\"a1b2\"",
    "entryCount": 612
  },
  { "type": "overlay", "url": "file://overlays/crypto-data.json", "fetchedAt": "…" }
]
```

`/health` MUST expose, per dictionary: `version`, `etag`, `entryCount`,
`loadedAt`, `stale`, `staleSince`, the per-source status, and the count of
validation warnings. A dictionary that is quietly stale is the failure mode this
whole design exists to prevent, so it is made loud.

---

## 16. Security model

### 16.1 What the service may call

The service never holds credentials at rest. It MAY execute its own catalogue
and pass the caller's own credential through, per entry, for the duration of one
request ([§9.7](#97-execute)). It MUST NOT call anything else.

Concretely, a server fetches only:

* its own configured `sources` and branch URLs — configuration, not user input,
  and SHOULD be allow-listed;
* when execution is enabled, the request an entry of an installed dictionary
  renders to — and only at an origin that dictionary declares.

The **declared origins** of a dictionary are the origins of every `http` entry's
effective `baseUrl` (or the origin of an absolute `urlTemplate`), with
`{{VARIABLE}}` references filled from deployment configuration. A base whose
host still contains an input placeholder declares nothing: the caller would be
choosing the host. Before sending, the server MUST check the resolved request's
origin — scheme, host and port — against that set and answer
`502 target_not_allowed` otherwise. Inputs are URL-encoded where they land in
the URL ([§5.5](#55-variables)), so a value cannot add a path segment, a port
or a userinfo; the origin check is the second, independent line.

A server that executes MUST NOT follow redirects, MUST bound each call by a
deadline no longer than its configured cap, and MUST stop reading an upstream
body at its configured byte cap ([§16.5](#165-denial-of-service)).

A server with execution off is a 0.1 server: it calls nothing an entry
describes, and says so with `403 execution_disabled`.

### 16.2 No credentials, ever

* `call.headers` and `defaults.headers` MUST NOT contain `authorization`,
  `proxy-authorization`, `cookie`, or any key matching
  `/api[-_]?key|secret|token|password/i` — even when the value is a
  `{{VARIABLE}}`. The credential header is declared through `auth`
  ([§5.4](#54-the-call-descriptor)), where a validator can see it for what it is.
* `call.baseUrl` and `urlTemplate` MUST NOT contain userinfo (`user:pass@`).
* The only place a document may reference a secret is `auth.value`, and only as
  a `{{VARIABLE}}` reference ([§5.5](#55-variables)). A variable declaration
  carries a name and a description, never a value.
* A server MUST reject, at validation, any document violating the above, and MUST
  scan string values — including header and query values — for obvious credential
  shapes (long high-entropy strings, `sk-`/`xox`/`ghp_` prefixes) and refuse them.

The consequence is that a dictionary is safe to serve publicly even when the API
it describes is private: it leaks the *shape* of an API, not access to it. An
operator who considers the shape itself sensitive authenticates the dictionary
([§16.4](#164-authentication)).

Execution ([§9.7.4](#974-the-callers-credential)) keeps every one of these
rules: the document still names a variable, the deployment still stores no
secret, and the value exists in the service only inside the request that
carried it. Deployment-configured variables are the non-secret ones of
[§5.5](#55-variables); a deployment MUST NOT be able to configure the variable
behind `auth.value`, so that a service can never become the thing that holds
everyone's key.

### 16.3 Tenancy

Each dictionary is an isolation boundary: its own index, its own search, its own
config, its own credentials for reading it. A search MUST NOT return an entry
from another dictionary unless that dictionary is reachable as a declared branch
of this one. Implementations SHOULD make the dictionary id part of every index
key so that cross-tenant leakage requires an explicit mistake rather than an
omission.

### 16.4 Authentication

Read access is per-dictionary: `public`, or bearer token. Admin routes (`PUT`,
`refresh`) always require a token, distinct from the read token. Tokens are
configuration, never stored in a dictionary.

### 16.5 Denial of service

Server-side caps, all configurable, all with sane defaults: query length 500,
`limit` 50, `maxBytes` 64 KB, request body 32 KB, per-token rate limit. Search
MUST be O(catalog) at worst and MUST complete inside a configured deadline
(default 2 s, well inside the consumer's 10 s), returning its best partial ranking
with `notice` rather than timing out.

Execution adds three: a per-call deadline cap (default 25 s; an entry's
`timeoutHintMs` is honoured only below it, default 10 s when the entry has
none), an upstream read cap applied while streaming, before anything is
buffered (default 1 MiB), and the same `maxBytes` budget on what is returned.
Executing calls count against the caller's rate limit like any other request.

### 16.6 Prompt injection surface

Every prose field in a dictionary is eventually rendered into a model's prompt.
A dictionary is therefore an injection vector, and a server SHOULD, at validation:
reject control characters and bidi overrides; reject fields containing the
consumer's known sentinels where configured; and flag imperative second-person
phrases in `summary`/`description` ("ignore previous instructions", "you must")
as warnings. This cannot be complete, so the normative rule is the operational
one: **a dictionary is trusted input, from a trusted source, installed by an
operator** — never accepted from an end user.

---

## 17. Conformance

### 17.1 A conforming document

Validates against `spec/schema/dictionary.schema.json` and satisfies:

1. Every `entries[].path` matches an index node `path`.
2. Every `relations[].target` resolves.
3. Entry `name` values are unique, including after alias expansion.
4. `urlTemplate` / `query` / `bodyTemplate` placeholders name declared input
   properties.
5. No credential-shaped values ([§16.2](#162-no-credentials-ever)).
6. `summary` ≤ 200 chars on every entry.
7. A `deprecated` entry has `deprecation.replacedBy`, a `successor` relation, or
   a `deprecation.note` saying what to do instead. An entry that is going away
   with no replacement is legitimate; an entry that is going away and says
   nothing is a dead end for the agent that finds it.
8. Every `{{VARIABLE}}` reference names a key of `defaults.variables`; a
   `secret` variable is referenced only from `auth.value`; `auth.value`
   references a `secret` variable; a placement (`in`/`name`/`value`) is complete,
   on `kind: "caller"`, and on an `http` call ([§5.5](#55-variables)).
9. Every `briefOf` names another entry of the same dictionary that carries no
   `briefOf` of its own, and no two entries name the same one ([§5.6](#56-briefs)).

### 17.2 A conforming server

1. Implements `POST /search`, `GET /index`, `GET /entries`, `GET /entries/{name}`,
   `GET /tool`, `GET /catalog`, `GET /version`, `GET /dictionaries`, `GET /health`.
2. Never returns an empty `results` array: falls back to the index
   ([§12](#12-empty-and-no-match-queries)).
3. Never exceeds `maxBytes`, and degrades in the order of
   [§11.3](#113-degradation-order).
4. Materializes inverse relations ([§6.2](#62-inverse-materialization)) and
   `brief` ([§5.6](#56-briefs)).
5. Returns `related` by default.
6. Emits canonical ETags ([§13.2](#132-etag)) and honours `If-None-Match`.
7. Calls an entry's endpoint only through `POST /execute`, only when the
   deployment enabled it, and only at a declared origin
   ([§16.1](#161-what-the-service-may-call)); otherwise never.
8. Answers a search within its configured deadline, in the worst case with a
   partial ranking.
9. When it offers `format: "text"`, reproduces the vectors in `conformance/text/`
   byte for byte: same response in, same bytes out ([§11.4](#114-text-rendering)).
   A consumer is allowed to assert on those bytes, so an implementation that
   renders "roughly that shape" is not conforming — it is a silent breaking
   change waiting for the next prompt-parsing consumer.
10. Accepts the request envelope on every POST route and resolves `dictionary`
    as [§9.8](#98-service-level-routes-and-the-request-envelope) says.
11. When it executes: validates `params` before calling, forwards only the
    credential the entry declares, never stores, logs or returns it, never
    follows a redirect, and never exceeds `maxBytes` in a result
    ([§9.7](#97-execute)).

### 17.3 Quality warnings (non-fatal)

A validator SHOULD report, without failing: entries with no `keywords`; entries
with no `relations` that have same-node siblings; a keyword appearing on > 25 % of
entries; `summary` identical to `title`; index nodes with no `sampleQueries`;
a `defaults.variables` entry nothing references; entries unreachable by any
single-word query drawn from their own `title`.

That last one is the useful one: it is a direct measure of "can this ever be
found".

---

## 18. Deliberate omissions and open questions

**Omitted on purpose**

* *Execution.* The service never calls anything ([§16.1](#161-the-service-never-executes)).
* *Auth schemes.* `auth.kind` is `none` or `caller` and nothing else. The
  document says *where* a credential goes and *which* executor-held variable
  fills it ([§5.5](#55-variables)) — enough for an executor to build the
  request — and stops there. Describing OAuth flows, token refresh or key
  exchange in a catalog invites someone to put a secret in one.
* *A type registry.* SEP #1888's `types` mode solves a problem this format does
  not have; schemas are inline.
* *Output schemas as a requirement.* `returns` prose is what a model needs to
  decide; `outputSchema` is optional for the executor.
* *Result-set caching keyed by query.* Left to HTTP.

**Open, for 0.2**

1. **Cross-dictionary relations.** `"<dictionaryId>#<name>"` is specified but
   only usable when both dictionaries are on the same server. A federated form
   needs a resolution rule.
2. **Multi-lingual dictionaries.** `locale` is document-level. A per-field
   language map would let one dictionary serve a Spanish and an English agent
   from the same entries. The first consumer is English-only, so this waits for a
   real case rather than being guessed at.
3. **Usage feedback.** The strongest possible `relations` signal is "agents that
   called X next called Y". An optional write path (`POST /telemetry`) could
   learn relations from traffic. Deferred because it needs a privacy story before
   it needs a schema.
4. **Negative keywords.** `"not a price feed"` is currently expressible only as
   prose in `summary`. A structured `excludes` field may earn its place.
5. **A canonical benchmark.** Conformance currently tests shape, not quality. A
   fixture set of (query → expected entry) pairs would make "did this change make
   discovery better" a measurable question. This is the most valuable of the five.
