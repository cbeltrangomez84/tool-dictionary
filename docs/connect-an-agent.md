# Connect an agent

Two HTTP calls wire a dictionary into any model that can call tools. Nothing
here is specific to a vendor: the declarations are plain JSON Schema, and the
search endpoint is plain HTTP.

## 1. Ask the server what exists

```bash
curl -s https://tools.example.com/v1/dictionaries
```

```json
{
  "dictionaries": [
    {
      "id": "city-weather",
      "title": "City weather",
      "summary": "Current conditions and short forecasts for any city.",
      "version": 1,
      "etag": "\"sha256:7d0bd8…\"",
      "entryCount": 3,
      "loaded": true,
      "stale": false,
      "public": true,
      "endpoints": {
        "search": "https://tools.example.com/v1/dictionaries/city-weather/search",
        "entries": "https://tools.example.com/v1/dictionaries/city-weather/entries",
        "index": "https://tools.example.com/v1/dictionaries/city-weather/index",
        "tool": "https://tools.example.com/v1/dictionaries/city-weather/tool",
        "catalog": "https://tools.example.com/v1/dictionaries/city-weather/catalog"
      }
    }
  ],
  "usage": "You have access to a tool dictionary covering Current conditions and short forecasts for any city. When a question needs data you do not have, search it before answering. …"
}
```

`usage` is a prompt paragraph written over every dictionary that is loaded. If
you front several, that is the paragraph to put in the system prompt.

## 2. Fetch the bundle

```bash
curl -s https://tools.example.com/v1/dictionaries/city-weather/tool
```

```json
{
  "dictionary": { "id": "city-weather", "version": 1, "etag": "\"sha256:7d0bd8…\"", "title": "City weather", "summary": "…", "entryCount": 3 },
  "tools": [
    {
      "name": "search_tools",
      "description": "Find the API tools that can answer the current question. Search with the words the user used — plain language works better than technical names. …",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "What you are looking for, in plain language. Empty to see the catalogue." },
          "limit": { "type": "integer", "description": "How many tools to return. Default 8, max 50.", "minimum": 1, "maximum": 50 },
          "path":  { "type": "string", "description": "Optional category path from the catalogue, e.g. \"tokens/holders\", to search only inside it." },
          "dictionary": { "type": "string", "description": "Optional dictionary id. Only needed when several dictionaries are available; when given it must be the one this endpoint serves." }
        },
        "required": ["query"]
      },
      "endpoint": "https://tools.example.com/v1/dictionaries/city-weather/search",
      "method": "POST"
    },
    {
      "name": "list_tools",
      "description": "List every tool in this dictionary as one line each: name and title. …",
      "input_schema": { "type": "object", "properties": { "path": { "type": "string", "description": "…" } } },
      "endpoint": "https://tools.example.com/v1/dictionaries/city-weather/entries",
      "method": "GET"
    }
  ],
  "systemPrompt": "You have access to a tool dictionary covering Current conditions and short forecasts for any city. When a question needs data you do not have, search it before answering. Search with the user's own words. Read the \"see also\" lines: they frequently name the tool you actually wanted. If you would rather see everything at once, list the tools; each line is a name you can search for exactly."
}
```

Hand `tools[]` to the model as its tool list (drop `endpoint` and `method` if
your vendor's schema is strict about extra keys — they are for your executor,
not the model) and put `systemPrompt` in the system prompt. That is the whole
integration. The bundle carries the dictionary ETag and honours `If-None-Match`,
so poll it cheaply and re-issue the declarations only when it changes.

Fronting several dictionaries? Fetch one bundle each and make the names unique
(`search_tools_city_weather`), or expose a single `search_tools` and route its
`dictionary` argument to `POST /v1/search` — the service resolves it, and
answers `400 dictionary_required` with the list of ids when the model left it
out and more than one applies.

## 3. Route the tool call

When the model calls `search_tools`, POST its arguments to `endpoint` and add
`"format": "text"`:

```bash
curl -s -X POST https://tools.example.com/v1/dictionaries/city-weather/search \
  -H 'content-type: application/json' \
  -d '{ "query": "is it raining in Lisbon", "format": "text" }'
```

```
DICTIONARY city-weather v1 — 1 result for "is it raining in Lisbon"

1. current_conditions — Current conditions
   Temperature, sky and wind in a city right now.
   path: weather
   input: city (string, required) — City name, optionally with country.
   returns: An object with tempC, sky, windKph and observedAt.
   call: GET https://api.weather.example/v1/current?city={city}  (auth: x-api-key header)
   see also: forecast_daily (pairs_with) — what comes next, once you know what it is like now

RELATED
   - forecast_daily — Daily forecast
     High, low and chance of rain per day for up to ten days.
     (pairs_with to current_conditions: what comes next, once you know what it is like now)

To use one, call it with the input shown. To see the full definition of any of
these, search again with its exact name.
```

Return that text as the tool result, verbatim. It is written for the model:
the top result is complete enough to call, the `see also` lines carry the
correction when the model searched for slightly the wrong thing, and a miss
returns the catalogue with searches that work. The rendering is normative to
the byte (spec §11.4) and frozen in [`conformance/`](../conformance/README.md),
so a prompt tuned against it stays tuned.

If you would rather parse than paste, omit `format` and you get the JSON of
spec §9.2, with the same `results`, `related` and `budget` fields.

## 4. Execute the tool the model picked

The model now knows it wants `current_conditions` with `{ "city": "Lisbon" }`.
Two ways to run it.

### 4a. Let the service execute (spec §9.7)

When the deployment has execution on ([Run the service](run-the-service.md#execution)),
the bundle carries a third tool, `execute_tool`, and `"execute": true`. Hand it
to the model with the other two; its loop becomes *search → execute by name*
and it never sees a URL. When the model calls it, POST the arguments to its
`endpoint` with the caller's credential in the header the entry names:

```bash
curl -s -X POST https://tools.example.com/v1/dictionaries/city-weather/execute \
  -H 'content-type: application/json' \
  -H 'x-api-key: the-callers-own-key' \
  -d '{ "name": "current_conditions", "params": { "city": "Lisbon" }, "format": "text" }'
```

```
current_conditions → 200 application/json (52 bytes)
{
  "tempC": 21,
  "sky": "clear",
  "windKph": 12,
  "observedAt": "…"
}
```

Return that as the tool result. The service validated `params` against the
entry's schema first (a mismatch is a `400 invalid_params` naming the field —
return the error message to the model, it knows what to fix), forwarded the
key only where the entry said it goes, and cut the body to the byte budget if
it was large (`truncated` tells the model to ask for less). The key was never
stored or logged; `x-td-var-<VARIABLE>` (e.g. `x-td-var-weather_api_key`) is
the generic header when the entry places its credential in the query string.

If your agent runtime forwards tool calls as one object, send it as-is: every
POST route accepts `{ "tool", "input": { …args }, "chatId", "callId" }` and
reads the arguments from `input` (spec §9.8).

### 4b. Execute it yourself

With execution off — the default — this is the step the service **does not
do**. Your backend turns the entry into a request and adds the credential:

```ts
import { resolveCall } from 'tool-dictionary';

const entry = catalog.entries.find((e) => e.name === 'current_conditions');
const request = resolveCall(entry, catalog, {
  input: { city: 'Lisbon' },
  variables: { WEATHER_API_KEY: process.env.WEATHER_API_KEY },
});
// { method: 'GET', url: 'https://api.weather.example/v1/current?city=Lisbon',
//   headers: { 'x-api-key': '…' } }
const response = await fetch(request.url, { method: request.method, headers: request.headers });
```

`resolveCall` applies the rules of spec §5.5 — path and query parameters,
`{{VARIABLE}}` substitution, the auth placement from `defaults` or the entry —
and throws a `ResolveError` naming the missing variable or parameter rather
than sending a half-built request. `catalog` is
`GET …/catalog`, cached by ETag; the entry the model saw at `full` detail is
the same object.

The key came from **your** environment. The dictionary only ever said where
it goes. That is the boundary the whole design rests on (spec §16), and it is
what lets you serve the dictionary publicly in front of a private API.

## Budget

The search response is measured in bytes and degrades in a specified order —
examples, then descriptions, then detail level from the bottom of the page up,
keeping the top result at full detail until the very last step — so a single
search always returns something callable inside `maxBytes` (default 12,000).
Pass `maxBytes` per request if your tool-result window is smaller; the server
clamps it and says so in `notice` rather than failing.
