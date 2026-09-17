# Run the service

The reference service is one process, no database. It loads every configured
dictionary before opening its port, builds a search index in memory, and serves
the HTTP API of spec §9.

## Configuration

One JSON file. Every string may reference an environment variable as
`${NAME}`, so the file can be committed without secrets.

```json
{
  "host": "0.0.0.0",
  "port": 8080,
  "publicBaseUrl": "https://tools.example.com",
  "trustProxy": true,
  "adminTokens": ["${TD_ADMIN_TOKEN}"],
  "rateLimitPerMinute": 600,
  "execution": { "enabled": false },
  "dictionaries": [
    {
      "id": "pool-scout",
      "source": { "kind": "url", "location": "https://api.poolscout.example/tool-dictionary.json", "refreshIntervalMs": 300000 },
      "readTokens": []
    },
    {
      "id": "city-weather",
      "source": { "kind": "file", "location": "../spec/examples/city-weather.dictionary.json" },
      "readTokens": ["${WEATHER_READ_TOKEN}"],
      "threshold": { "minScore": 1.0, "relativeFloor": 0.15 },
      "execute": false
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `publicBaseUrl` | The address clients reach you at. Fills the absolute `endpoint`s in the agent bundle; behind a proxy this is the only way the bundle can be right. Also `TD_PUBLIC_BASE_URL`. |
| `adminTokens` | Bearer tokens that may `PUT` any dictionary, including a new id, and trigger `refresh`. Also `TD_ADMIN_TOKENS`, comma-separated. |
| `source.kind` | `file` (relative to the config file), `url` (fetched at start and every `refreshIntervalMs`), or `inline`. |
| `readTokens` | Bearer tokens required to read this dictionary. Empty means public. |
| `execute` | Per dictionary: `false` keeps this one search-only even when `execution.enabled` is on. Default `true`. |
| `execution` | Catalogue execution (spec §9.7), off unless `enabled` is `true`. See [Execution](#execution). |
| `threshold` | When a hit counts as a match: an absolute BM25 floor and a fraction of the top score. Below both, the search returns the index instead. |
| `limits` | Result and byte caps (`defaultLimit`, `maxLimit`, `defaultMaxBytes`, `maxMaxBytes`, `maxQueryChars`, `searchDeadlineMs`). Defaults are the spec's. |
| `rateLimitPerMinute` | Per token, or per IP for anonymous callers. `0` disables. |
| `trustProxy` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` from the peer: `true`, or a comma-separated list of proxy addresses / CIDRs (a hop count is not accepted; Fastify 5 cannot validate the peer from one). Set it whenever a reverse proxy (Caddy, nginx, a load balancer) sits in front, otherwise every anonymous caller shares the proxy's IP and therefore one rate-limit bucket. Also `TD_TRUST_PROXY`. |

`TD_HOST`, `TD_PORT`, `TD_TRUST_PROXY` and `TD_EXECUTE` override the file. `TD_CONFIG` names the file when no
argument is given.

```bash
TD_ADMIN_TOKEN=change-me npm run dev -- config/local.json     # from source
TD_ADMIN_TOKEN=change-me node dist/index.js config/local.json # after npm run build
```

```
loaded pool-scout v1 — 8 entries
loaded city-weather v1 — 3 entries
```

With execution on, a dictionary the service will run ends its line with
`, executes`.

A dictionary that fails to load at start is a failed start, on purpose: a 503
discovered by an agent mid-conversation is the worse outcome.

## Freshness

The service **pulls**; nobody registers a snapshot with it (spec §13.3).

* A `url` source is re-fetched every `refreshIntervalMs`. A fetch that fails, or
  returns an invalid document, keeps the last good copy and marks the dictionary
  `stale: true` in `/v1/health` and `/v1/dictionaries`.
* `POST /v1/dictionaries/{id}/refresh` (admin) forces a pull now.
* `PUT /v1/dictionaries/{id}` (admin, body = the document) replaces it in place.
  With a global admin token the id may be new. The document is validated first;
  an invalid one is rejected with the validator's errors and nothing changes.

Every read endpoint carries the dictionary's ETag and honours `If-None-Match`;
the ETag is a hash of the document bytes, so it changes exactly when the content
does, whatever `version` says.

## Execution

Off by default: a fresh install is a search-only service and calls nothing an
entry describes. Turn it on when you want the agent's loop to be *search →
execute by name* with the model never handling a URL or a key (spec §9.7):

```json
{
  "execution": {
    "enabled": true,
    "maxTimeoutMs": 25000,
    "defaultTimeoutMs": 10000,
    "maxResponseBytes": 1048576,
    "variables": { "REGION": "${REGION}" }
  }
}
```

| Key | Meaning |
|---|---|
| `enabled` | Also `TD_EXECUTE=true\|false`, which wins over the file. |
| `maxTimeoutMs` | Hard cap on one upstream call. An entry's `timeoutHintMs` is honoured only below it; `defaultTimeoutMs` applies when the entry has none. Defaults 25 000 / 10 000. |
| `maxResponseBytes` | The service stops reading an upstream body here (default 1 MiB) and marks the result truncated. Independent of the response `maxBytes` budget, which is applied afterwards. |
| `variables` | Values for the non-secret `{{VARIABLE}}` references a dictionary declares (a region, a tenant). The credential variable behind `auth.value` is **never** configured here — it arrives with each request. |

What the service does per call: validates `params` against the entry's input
schema (a mismatch is a 400 naming the field, before anything is sent), renders
the descriptor, checks the resolved origin against the origins the dictionary
declares, forwards the caller's credential from the request header (the header
the entry names, e.g. `x-api-key`, or the generic `x-td-var-<variable>`), sends
the call without following redirects, reads at most `maxResponseBytes`, and
returns the upstream's answer — whatever its status — under the byte budget.
The credential is never stored, logged or echoed.

```bash
curl -s -X POST localhost:8080/v1/dictionaries/city-weather/execute \
  -H 'content-type: application/json' -H 'x-api-key: the-callers-own-key' \
  -d '{ "name": "current_conditions", "params": { "city": "Lisbon" } }'
```

```json
{
  "kind": "result", "dictionary": { "id": "city-weather", "version": 1, "etag": "\"sha256:…\"" },
  "tool": "current_conditions", "status": 200, "contentType": "application/json",
  "body": { "tempC": 21, "sky": "clear" }, "bodyFormat": "json",
  "bytes": 29, "truncated": false, "elapsedMs": 180,
  "budget": { "maxBytes": 12000, "usedBytes": 262, "truncated": false }
}
```

`/v1/execute` (and `/v1/search`, `/v1/entries`, `/v1/tool`) take a
`dictionary` argument instead of the path id, and pick the only visible
dictionary when it is omitted. Every POST body is also accepted wrapped as
`{ "tool", "input": { …args }, "chatId", "callId" }`, the shape agent runtimes
forward (spec §9.8).

## What `/v1/health` tells you

```bash
curl -s localhost:8080/v1/health
```

```json
{
  "ok": true,
  "now": "2026-09-16T10:00:00.000Z",
  "limits": { "defaultLimit": 8, "maxLimit": 50, "defaultMaxBytes": 12000, "maxMaxBytes": 65536, "...": "..." },
  "execution": { "enabled": false, "maxTimeoutMs": 25000, "defaultTimeoutMs": 10000, "maxResponseBytes": 1048576, "variables": [] },
  "dictionaries": [
    { "id": "pool-scout", "version": 1, "etag": "\"sha256:…\"", "entryCount": 8, "loaded": true, "stale": false, "public": true, "execute": false, "..." : "..." }
  ]
}
```

`ok` is process liveness. `stale` per dictionary is the signal to alert on: the
service is answering, from a copy it could not refresh. `execution.variables`
lists configured variable *names* only; `execute` per dictionary says whether
this deployment will run it.

## As a dependency

The package builds itself on install (`prepare`), so it can be pinned straight
from git and embedded in another service:

```bash
npm install github:cbeltrangomez84/tool-dictionary#v0.2.0
```

```ts
import { buildServer, DictionaryService } from 'tool-dictionary';

const service = new DictionaryService({ globalAdminTokens: [process.env.TD_ADMIN_TOKEN!] });
await service.install({ id: 'pool-scout', source: { kind: 'file', location: '/etc/tool-dictionary/pool-scout.json' } });
const app = buildServer({ service, trustProxy: true, publicBaseUrl: 'https://tools.example.com' });
await app.listen({ host: '0.0.0.0', port: 8080 });
```

`renderResultsText`, `renderIndexText` and `renderEntriesText` are exported too,
for hosts that serve the text form over their own transport.

## Docker

```bash
docker build -t tool-dictionary .
docker run --rm -p 8080:8080 \
  -v "$PWD/config:/config:ro" \
  -e TD_CONFIG=/config/tool-dictionary.json \
  -e TD_ADMIN_TOKEN=change-me \
  tool-dictionary
```

The image is two-stage, carries only production dependencies and the compiled
output plus the JSON Schema, runs as the unprivileged `node` user, listens on
`0.0.0.0:8080` and has a `HEALTHCHECK` on `/v1/health`. File sources inside the
container are relative to the config file, so mount the dictionary next to it
or use a `url` source.

## What it will never do

Hold a credential, or call anything a dictionary does not declare. The service
knows a dictionary says `x-scout-key` goes in a header and is called
`{{POOL_SCOUT_API_KEY}}`; it has nowhere to store the value. With execution off
it has no code path that sends a request an entry describes, and your executor
does that — see [Connect an agent](connect-an-agent.md). With execution on it
sends only what an installed entry renders to, only at an origin that
dictionary declares, and only with the credential the caller handed it for that
one request. Either way it is safe to run in front of an API you would not
expose directly (spec §16).
