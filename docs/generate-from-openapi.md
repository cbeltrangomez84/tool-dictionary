# Generate a dictionary from OpenAPI

A hand-written catalog of six hundred endpoints is wrong within a month. The
generator turns an OpenAPI 3.x document into a valid dictionary on every build;
an **overlay** — a small file you maintain by hand — carries the knowledge no
generator can derive, and is merged deterministically on top each time.

```
generate(openapi) + overlay = dictionary
```

This guide walks the worked example in
[`spec/examples/pool-scout/`](../spec/examples/pool-scout/README.md): a
fictional liquidity-pool API with the flaws real documents have — no
`operationId`, one tag, `"Default Response"` on every response.

## 1. The seed

```bash
npm run build
node dist/generate/cli.js \
  --openapi spec/examples/pool-scout/openapi.json \
  --id pool-scout \
  --strip-prefix api --strip-prefix public \
  --base-url https://api.poolscout.example \
  --out /tmp/pool-scout.seed.json
```

```
pool-scout v1 — 8 entries → /tmp/pool-scout.seed.json
  warning: entries[].keywords: keyword "pools" appears on 8/8 entries; it no longer discriminates
  warning: entries[].keywords: keyword "pool" appears on 8/8 entries; it no longer discriminates
  warning: entries[].keywords: keyword "chain" appears on 7/8 entries; it no longer discriminates
  ...
```

The output is validated before it is written: a run either produces a servable
dictionary or exits non-zero. Here is one generated entry:

```json
{
  "name": "get_pools_liquidity",
  "title": "Liquidity depth and how much of it can leave",
  "summary": "Reserves and TVL, plus the share of LP tokens that is locked or burned.",
  "path": "pools",
  "keywords": ["pools", "pool", "liquidity", "chain", "depth", "leave"],
  "returns": "An object with tvlUsd, reserves, lpSupply, lockedPct, burnedPct, change24hPct.",
  "relations": [
    { "type": "pairs_with", "target": "get_pools", "reason": "same resource: pools", "weight": 0.3 },
    ...
  ]
}
```

What the generator got right without help: a stable name from the method and
path (`api` and `public` stripped, because they are routing, not meaning); a
`returns` line read off the **response schema**, since the response description
was a placeholder; the API-key placement hoisted into `defaults.auth` with a
`{{POOL_SCOUT_API_KEY}}` variable, and `auth: { kind: "none" }` on the one
operation declared public.

What it could not know: that a person asking about this tool says *rug* or
*is the LP locked*; that the summary makes a better title than the sentence
the vendor wrote; that this tool and `get_pools_providers` are the two halves
of one question. The seeded relations are honest — *same resource* — and weak.

## 2. The overlay

[`spec/examples/pool-scout/overlay.json`](../spec/examples/pool-scout/overlay.json)
is the whole human contribution. The part that touches the entry above:

```json
{
  "toolDictionaryOverlay": "0.1",
  "dictionaryId": "pool-scout",
  "synonyms": { "liquidity": ["lp", "tvl", "depth"], "locked": ["locker", "vested"] },
  "entries": {
    "*": { "keywords": { "remove": ["pools", "pool"] } },
    "get_pools_liquidity": {
      "title": "Liquidity and lock status",
      "summary": "Reserves and TVL, plus how much of the LP is locked or burned — the figure that says whether the liquidity can be pulled.",
      "keywords": { "add": ["rug", "rugpull", "can liquidity be pulled", "lp locked", "lp burned", "locked", "burned", "reserves", "tvl", "depth"] },
      "relations": { "add": [
        { "type": "pairs_with", "target": "get_pools_providers", "reason": "an unlocked LP is only a risk if few wallets hold it", "weight": 0.9 },
        { "type": "broader", "target": "get_pools", "reason": "the same TVL plus venue, pair and price" }
      ] }
    }
  }
}
```

The rules that make this safe to re-run forever (spec §15.2):

* Scalars **replace**. Lists take `{ "add": [], "remove": [] }`, or a bare array
  to replace outright.
* `"*"` patches every entry and runs first, so a named patch still wins. One
  line drops the two keywords the generator put on all eight entries; the same
  line drops them from five hundred.
* An authored relation to a target **replaces** the seeded one to that target.
  The `broader` above supersedes the mechanical `pairs_with` to `get_pools`.
* Index listings (`examples`, `sampleQueries`) are re-derived after the merge,
  so moving an entry to another `path` moves it in the index too.
* An overlay key naming something that no longer exists is **reported, not
  swallowed**. That message is how you learn upstream renamed an operation.

## 3. Put them together

```bash
node dist/generate/cli.js \
  --openapi spec/examples/pool-scout/openapi.json \
  --overlay spec/examples/pool-scout/overlay.json \
  --id pool-scout \
  --strip-prefix api --strip-prefix public \
  --base-url https://api.poolscout.example \
  --source-url https://api.poolscout.example/openapi.json \
  --overlay-url https://github.com/cbeltrangomez84/tool-dictionary/blob/main/spec/examples/pool-scout/overlay.json \
  --out dictionaries/pool-scout.json
```

`--source-url` and `--overlay-url` are recorded in `sources[]` as where a
reader can fetch the inputs, rather than as paths on the machine that ran the
build. `npm run example` runs exactly this for the checked-in example, and a
test asserts the result is byte-identical to what is committed.

## 4. Keep it fresh in CI

```bash
node dist/generate/cli.js \
  --openapi https://api.poolscout.example/openapi.json \
  --overlay overlays/pool-scout.json \
  --id pool-scout \
  --previous dictionaries/pool-scout.json \
  --strict \
  --out dictionaries/pool-scout.json
```

* `--openapi` accepts a URL. Run this on every deploy of the upstream service.
* `--previous` reuses the last version when nothing changed and bumps it when
  something did — comparing everything except `version`, `generatedAt` and
  `sources` — so a rebuild that found nothing new does not invalidate every
  consumer's cache.
* `--strict` turns warnings and stale overlay keys into a non-zero exit. That is
  the moment a renamed operation upstream becomes a failing build here, instead
  of a silently dead overlay entry.

Then serve the file, or `PUT` it to a running service — see
[Run the service](run-the-service.md).

## Reference

`node dist/generate/cli.js --help` lists every flag. The mapping from OpenAPI
fields to dictionary fields is the table in spec §15.1; the overlay format is
spec §15.2.
