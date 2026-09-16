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
  "adminTokens": ["${TD_ADMIN_TOKEN}"],
  "rateLimitPerMinute": 600,
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
      "threshold": { "minScore": 1.0, "relativeFloor": 0.15 }
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
| `threshold` | When a hit counts as a match: an absolute BM25 floor and a fraction of the top score. Below both, the search returns the index instead. |
| `limits` | Result and byte caps (`defaultLimit`, `maxLimit`, `defaultMaxBytes`, `maxMaxBytes`, `maxQueryChars`, `searchDeadlineMs`). Defaults are the spec's. |
| `rateLimitPerMinute` | Per token, or per IP for anonymous callers. |

`TD_HOST` and `TD_PORT` override the file. `TD_CONFIG` names the file when no
argument is given.

```bash
TD_ADMIN_TOKEN=change-me npm run dev -- config/local.json     # from source
TD_ADMIN_TOKEN=change-me node dist/index.js config/local.json # after npm run build
```

```
loaded pool-scout v1 — 8 entries
loaded city-weather v1 — 3 entries
```

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

## What `/v1/health` tells you

```bash
curl -s localhost:8080/v1/health
```

```json
{
  "ok": true,
  "now": "2026-09-16T10:00:00.000Z",
  "limits": { "defaultLimit": 8, "maxLimit": 50, "defaultMaxBytes": 12000, "maxMaxBytes": 65536, "...": "..." },
  "dictionaries": [
    { "id": "pool-scout", "version": 1, "etag": "\"sha256:…\"", "entryCount": 8, "loaded": true, "stale": false, "public": true, "..." : "..." }
  ]
}
```

`ok` is process liveness. `stale` per dictionary is the signal to alert on: the
service is answering, from a copy it could not refresh.

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

Execute a tool, or hold a credential. The service knows a dictionary says
`x-scout-key` goes in a header and is called `{{POOL_SCOUT_API_KEY}}`; it does
not know the value and has no code path that could send it. Your executor does
that — see [Connect an agent](connect-an-agent.md). This is the boundary that
makes it safe to run the service in front of an API you would not expose
directly (spec §16).
