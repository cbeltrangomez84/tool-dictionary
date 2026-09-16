# Conformance vectors

Frozen inputs and outputs for the parts of Tool Dictionary 0.1 that a consumer is
allowed to assert on. Today that is the plain-text rendering
([spec §11.4](../spec/tool-dictionary-v0.1.md#114-text-rendering)), which is
normative to the byte because consumers paste it straight into a prompt and parse
what comes back.

## Layout

```
fixtures/vectors.dictionary.json   a small dictionary that contains, on purpose, every
                                   case the rendering has a rule for
text/<case>.json                   { case, covers, dictionary, request, response }
text/<case>.txt                    the exact bytes that response renders to
text/manifest.json                 every case with its kind and byte length
```

Cases `01`–`07` were produced by running `request` against the reference service
with the named dictionary loaded (`crypto-data` is
[`spec/examples/crypto-data.dictionary.json`](../spec/examples/crypto-data.dictionary.json)).
Case `08` is hand-authored: a `[unavailable]` node only appears when a branch
fails to load, and a vector must not depend on a network failure to reproduce.

| Case | Covers |
|---|---|
| `01-results-auto` | The common case: `auto` detail, ranks 1–3 at `full`, a `RELATED` section, no notice |
| `02-results-degraded` | A budget too small for the page: `NOTE:`, reduced detail, `MORE:` cursor |
| `03-results-single-summary` | Singular `1 result`, explicit `summary` detail, related suppressed |
| `04-results-risk-and-deprecation` | `BETA`, `DEPRECATED`, `RISK:`; enum/default/required facets; examples with and without a note |
| `05-results-mcp-and-local` | MCP and local call rendering, and a tool that takes no input |
| `06-index-empty-query` | Empty query returns the index: nesting, `try:` and `e.g.` lines |
| `07-index-below-threshold` | A miss returns the index with `DID YOU MEAN` |
| `08-index-degraded-branch` | A branch that failed to load renders as `[unavailable]` rather than disappearing |

## Using them as a consumer

You do not need this repository's code. Either

* **render-level** — feed `<case>.json` → `response` into your renderer and
  compare with `<case>.txt`, or
* **service-level** — load the named dictionary into whatever server you use,
  POST `<case>.json` → `request` with `format: "text"`, and compare the body with
  `<case>.txt`.

Compare bytes, not lines: the files are UTF-8 with LF endings and **no trailing
newline**. `git` will not add one — `.gitattributes` keeps them binary-exact.

## Using them as an implementer

`npm test` runs `test/conformance.test.ts`, which asserts both directions above
plus the invariants a consumer may rely on (first line starts `DICTIONARY `, the
closing instruction is always present, no heading is ever emitted empty, and the
text is smaller than the same response as JSON — measured 25–43 % smaller across these eight vectors).

Regenerate after a deliberate rendering change:

```bash
npm run conformance     # rewrites text/*, then review the diff
npm test
```

A vector diff is the review artifact. Changing the rendering without changing
§11.4 and these files in the same commit is the failure mode this directory
exists to prevent.
